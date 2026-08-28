const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { reconcile } = require('./helpers/reconcile-harness');

const SERVICE = `
services:
    svc:
        image: nginx:1.27
        container_name: svc
        labels:
            - 'iobEnabled=true'
        ports:
            - '8080:80'
`;

/** The compose snippets that used to recreate the container on every single check */
const UNCHANGED_CASES = {
    'a healthcheck': `        healthcheck:
            test: ['CMD', 'curl', '-f', 'http://localhost']
            interval: 30s
            retries: 3
`,
    'an expose list': `        expose:
            - '9000'
`,
    'an env_file': `        env_file:
            - ./nonexistent.env
`,
    'dns servers': `        dns:
            - 8.8.8.8
`,
    'a stop grace period': `        stop_grace_period: 30s
`,
    'a memory limit': `        mem_limit: 512m
`,
    'a cpu limit': `        cpus: 1.5
`,
    'a device': `        devices:
            - /dev/bus/usb:/dev/bus/usb
`,
    'a device without a container path': `        devices:
            - /dev/video0
`,
};

describe('reconcile', () => {
    describe('a container that already matches its configuration', () => {
        it('should be left alone when the service is plain', async () => {
            const { events } = await reconcile(SERVICE);
            if (events.length) {
                throw new Error(`Expected no action, got ${events.join(',')}`);
            }
        });

        for (const [what, snippet] of Object.entries(UNCHANGED_CASES)) {
            it(`should be left alone with ${what}`, async () => {
                const { events, logs } = await reconcile(SERVICE + snippet);
                if (events.length) {
                    const reasons = logs.filter(([lvl]) => lvl === 'info').map(([, text]) => text);
                    throw new Error(`Expected no action, got ${events.join(',')}: ${reasons.join(' | ')}`);
                }
            });
        }

        it('should be left alone with a tmpfs mount', async () => {
            const { events } = await reconcile(`
services:
    svc:
        image: nginx:1.27
        container_name: svc
        labels:
            - 'iobEnabled=true'
        volumes:
            - type: tmpfs
              target: /run
`);
            if (events.length) {
                throw new Error(`Expected no action, got ${events.join(',')}`);
            }
        });

        it('should be left alone when it shares the network stack of another service', async () => {
            const { events } = await reconcile(`
services:
    other:
        image: busybox:latest
        container_name: other
        labels:
            - 'iobEnabled=true'
    svc:
        image: nginx:1.27
        container_name: svc
        network_mode: 'service:other'
        labels:
            - 'iobEnabled=true'
`);
            if (events.length) {
                throw new Error(`Expected no action, got ${events.join(',')}`);
            }
        });
    });

    describe('a container that really differs', () => {
        it('should be recreated when a published port changed', async () => {
            const { events } = await reconcile(SERVICE, {
                mutate: inspect => {
                    inspect.HostConfig.PortBindings = { '80/tcp': [{ HostPort: '9999', HostIp: '' }] };
                },
            });
            if (!events.includes('RECREATE')) {
                throw new Error('A changed port must recreate the container');
            }
        });

        it('should be recreated when the image changed', async () => {
            const { events } = await reconcile(SERVICE, {
                mutate: inspect => {
                    inspect.Config.Image = 'nginx:1.20';
                },
            });
            if (!events.includes('RECREATE')) {
                throw new Error('A changed image must recreate the container');
            }
        });

        it('should be recreated when the healthcheck interval changed', async () => {
            const { events } = await reconcile(SERVICE + UNCHANGED_CASES['a healthcheck'], {
                mutate: inspect => {
                    inspect.Config.Healthcheck.Interval = 5 * 1_000_000_000;
                },
            });
            if (!events.includes('RECREATE')) {
                throw new Error('A changed healthcheck must recreate the container');
            }
        });

        it('should be recreated when a device was added to the configuration', async () => {
            const { events } = await reconcile(SERVICE + UNCHANGED_CASES['a device'], {
                mutate: inspect => {
                    inspect.HostConfig.Devices = null;
                },
            });
            if (!events.includes('RECREATE')) {
                throw new Error('A device that the running container does not have must recreate it');
            }
        });

        it('should be recreated, not skipped, when the running container has no such setting at all', async () => {
            // Reading a sub key off the missing object used to throw, which aborted the check of
            // this container: it was neither recreated nor started nor monitored.
            const { events, logs } = await reconcile(SERVICE + UNCHANGED_CASES['a healthcheck'], {
                mutate: inspect => {
                    delete inspect.Config.Healthcheck;
                },
            });
            const failures = logs.filter(([lvl, text]) => lvl === 'warn' && text.includes('Cannot check'));
            if (failures.length) {
                throw new Error(`The check must not fail: ${failures.map(([, t]) => t).join(' | ')}`);
            }
            if (!events.includes('RECREATE')) {
                throw new Error('A missing healthcheck on the running container must recreate it');
            }
        });
    });

    describe('env_file', () => {
        let dir;

        before(() => {
            dir = mkdtempSync(join(tmpdir(), 'plugin-docker-env-'));
            writeFileSync(
                join(dir, 'my.env'),
                '# a comment\n\nFROM_FILE=1\nQUOTED="with spaces"\nSHARED=file\nexport EXPORTED=yes\n',
            );
        });

        after(() => rmSync(dir, { recursive: true, force: true }));

        const withEnvFile = `
services:
    svc:
        image: nginx:1.27
        container_name: svc
        env_file:
            - ./my.env
        environment:
            SHARED: service
        labels:
            - 'iobEnabled=true'
`;

        it('should merge the variables into the environment, because docker has no env_file', async () => {
            const { config } = await reconcile(withEnvFile, { adapterDir: dir });
            if (config.environment.FROM_FILE !== '1') {
                throw new Error(`FROM_FILE was not taken over: ${JSON.stringify(config.environment)}`);
            }
            if (config.environment.QUOTED !== 'with spaces') {
                throw new Error(`Quotes must be stripped: ${JSON.stringify(config.environment.QUOTED)}`);
            }
            if (config.environment.EXPORTED !== 'yes') {
                throw new Error(`An "export" prefix must be tolerated: ${JSON.stringify(config.environment)}`);
            }
            if (config.envFile) {
                throw new Error('envFile must be dropped once it is resolved');
            }
        });

        it('should let an explicit environment entry win over the file, as compose does', async () => {
            const { config } = await reconcile(withEnvFile, { adapterDir: dir });
            if (config.environment.SHARED !== 'service') {
                throw new Error(`environment: must win, got ${config.environment.SHARED}`);
            }
        });

        it('should warn and keep going when the file is missing', async () => {
            const { events, logs } = await reconcile(SERVICE + UNCHANGED_CASES['an env_file'], { adapterDir: dir });
            if (!logs.some(([lvl, text]) => lvl === 'warn' && text.includes('nonexistent.env'))) {
                throw new Error(`Expected a warning about the missing file, got ${JSON.stringify(logs)}`);
            }
            if (events.length) {
                throw new Error(`A missing env file must not change the container, got ${events.join(',')}`);
            }
        });
    });
});
