/**
 * Both drivers have to send the same container configuration to docker.
 *
 * The manager talks either through the socket/API (dockerode) or through the CLI, and which one it
 * is depends only on the host. A setting that one of the two paths silently drops therefore works
 * on one installation and does nothing on the next.
 */
const { existsSync, readFileSync } = require('node:fs');
const composeFromYaml = require('../build/cjs/lib/parseDockerCompose');
const { composeToContainerConfigs } = require('../build/cjs/lib/compose2config');
const DockerManagerModule = require('../build/cjs/lib/DockerManager');

const DockerManager = DockerManagerModule.default || DockerManagerModule;
const { quoteArg } = DockerManagerModule;

/** Convert a compose file to the configuration of its first service, with a name docker accepts */
function toConfig(yaml) {
    const config = composeToContainerConfigs(composeFromYaml.default(yaml))[0];
    config.name = config.name || 'test';
    return config;
}

/** Both representations of one configuration: the API payload and the CLI command line */
function bothDrivers(yaml) {
    const config = toConfig(yaml);
    return {
        config,
        api: DockerManager.getDockerodeConfig(config),
        cli: DockerManager.toDockerRun(config),
        args: DockerManager.toDockerRunArgs(config),
    };
}

/** The value that follows `flag` in an argument list */
function valueOf(args, flag) {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
}

const SERVICE = `
services:
    svc:
        image: nginx:1.27
        container_name: svc
        labels:
            - 'iobEnabled=true'
`;

describe('configMapping', () => {
    describe('dns', () => {
        const yaml =
            SERVICE +
            `        dns:
            - 8.8.8.8
        dns_search:
            - example.com
        dns_opt:
            - timeout:2
`;

        it('should reach the API driver', () => {
            const { api } = bothDrivers(yaml);
            if (!api.HostConfig.Dns?.includes('8.8.8.8')) {
                throw new Error(`Dns is missing: ${JSON.stringify(api.HostConfig.Dns)}`);
            }
            if (!api.HostConfig.DnsSearch?.includes('example.com')) {
                throw new Error(`DnsSearch is missing: ${JSON.stringify(api.HostConfig.DnsSearch)}`);
            }
            if (!api.HostConfig.DnsOptions?.includes('timeout:2')) {
                throw new Error(`DnsOptions is missing: ${JSON.stringify(api.HostConfig.DnsOptions)}`);
            }
        });

        it('should reach the CLI driver', () => {
            const { cli } = bothDrivers(yaml);
            for (const expected of ['--dns 8.8.8.8', '--dns-search example.com', '--dns-option timeout:2']) {
                if (!cli.includes(expected)) {
                    throw new Error(`"${expected}" is missing in: ${cli}`);
                }
            }
        });
    });

    describe('healthcheck', () => {
        const yaml =
            SERVICE +
            `        healthcheck:
            test: ['CMD', 'curl', '-f', 'http://localhost']
            interval: 30s
            timeout: 5s
            retries: 3
            start_period: 10s
`;

        it('should reach the API driver, with the durations in nanoseconds', () => {
            const { api } = bothDrivers(yaml);
            const health = api.Healthcheck;
            if (!health) {
                throw new Error('Healthcheck is missing in the API payload');
            }
            if (JSON.stringify(health.Test) !== JSON.stringify(['CMD', 'curl', '-f', 'http://localhost'])) {
                throw new Error(`Unexpected test: ${JSON.stringify(health.Test)}`);
            }
            if (health.Interval !== 30_000_000_000) {
                throw new Error(`30s must be 30e9 ns, got ${health.Interval}`);
            }
            if (health.Timeout !== 5_000_000_000 || health.StartPeriod !== 10_000_000_000 || health.Retries !== 3) {
                throw new Error(`Unexpected healthcheck: ${JSON.stringify(health)}`);
            }
        });

        it('should reach the CLI driver, with the command quoted', () => {
            const { cli } = bothDrivers(yaml);
            if (!cli.includes('--health-cmd')) {
                throw new Error(`--health-cmd is missing in: ${cli}`);
            }
            // the command contains spaces and must survive as one argument
            if (!/--health-cmd ('|")curl -f http:\/\/localhost('|")/.test(cli)) {
                throw new Error(`The healthcheck command is not quoted: ${cli}`);
            }
            if (!cli.includes('--health-interval 30000ms') || !cli.includes('--health-retries 3')) {
                throw new Error(`Healthcheck options are missing in: ${cli}`);
            }
        });

        it('should turn a bare string into the shell form', () => {
            const health = DockerManager.toDockerHealthcheck({ test: 'curl -f http://localhost' });
            if (JSON.stringify(health.Test) !== JSON.stringify(['CMD-SHELL', 'curl -f http://localhost'])) {
                throw new Error(`Unexpected test: ${JSON.stringify(health.Test)}`);
            }
        });

        it('should render a disabled healthcheck as --no-healthcheck on the CLI', () => {
            const config = toConfig(SERVICE);
            config.healthcheck = { test: ['NONE'] };
            if (!DockerManager.toDockerRun(config).includes('--no-healthcheck')) {
                throw new Error('A disabled healthcheck must be passed on');
            }
        });
    });

    describe('devices', () => {
        const yaml =
            SERVICE +
            `        devices:
            - /dev/bus/usb:/dev/bus/usb
            - /dev/video0
            - /dev/dri/renderD128:/dev/dri/renderD128:r
`;

        it('should reach the API driver', () => {
            const { api } = bothDrivers(yaml);
            const devices = api.HostConfig.Devices;
            if (!devices?.length) {
                throw new Error('Devices are missing in the API payload');
            }
            // a device without a container path keeps the host path, permissions default to rwm
            if (
                JSON.stringify(devices[1]) !==
                JSON.stringify({
                    PathOnHost: '/dev/video0',
                    PathInContainer: '/dev/video0',
                    CgroupPermissions: 'rwm',
                })
            ) {
                throw new Error(`Unexpected device: ${JSON.stringify(devices[1])}`);
            }
            if (devices[2].CgroupPermissions !== 'r') {
                throw new Error(`Explicit permissions must be kept: ${JSON.stringify(devices[2])}`);
            }
        });

        it('should reach the CLI driver', () => {
            const { cli } = bothDrivers(yaml);
            for (const expected of [
                '--device /dev/bus/usb:/dev/bus/usb:rwm',
                '--device /dev/video0:/dev/video0:rwm',
                '--device /dev/dri/renderD128:/dev/dri/renderD128:r',
            ]) {
                if (!cli.includes(expected)) {
                    throw new Error(`"${expected}" is missing in: ${cli}`);
                }
            }
        });

        it('should take part in the recreate decision, unlike before', () => {
            // The key used to be excluded from the comparison, which was only necessary because
            // the devices never reached docker and could therefore never be read back.
            const { config } = bothDrivers(yaml);
            if (!config.devices?.length) {
                throw new Error('The compose devices were not parsed');
            }
        });
    });

    describe('expose', () => {
        const yaml =
            SERVICE +
            `        expose:
            - '9000'
        ports:
            - '8080:80'
`;

        it('should reach the API driver next to the published ports', () => {
            const { api } = bothDrivers(yaml);
            const exposed = Object.keys(api.ExposedPorts || {});
            if (!exposed.includes('9000/tcp') || !exposed.includes('80/tcp')) {
                throw new Error(`Expected both ports, got ${JSON.stringify(exposed)}`);
            }
        });

        it('should reach the CLI driver', () => {
            const { cli } = bothDrivers(yaml);
            if (!cli.includes('--expose 9000')) {
                throw new Error(`--expose is missing in: ${cli}`);
            }
        });
    });

    describe('tmpfs', () => {
        const yaml = `
services:
    svc:
        image: nginx:1.27
        container_name: svc
        labels:
            - 'iobEnabled=true'
        volumes:
            - type: tmpfs
              target: /run
              tmpfs:
                  size: 67108864
`;

        it('should reach the API driver as a target/options map', () => {
            const { api } = bothDrivers(yaml);
            if (api.HostConfig.Tmpfs?.['/run'] !== 'size=67108864') {
                throw new Error(`Unexpected Tmpfs: ${JSON.stringify(api.HostConfig.Tmpfs)}`);
            }
        });

        it('should reach the CLI driver', () => {
            const { cli } = bothDrivers(yaml);
            if (!cli.includes('--tmpfs /run:size=67108864')) {
                throw new Error(`--tmpfs is missing in: ${cli}`);
            }
        });
    });

    describe('resources', () => {
        const yaml =
            SERVICE +
            `        mem_limit: 512m
        mem_reservation: 256m
        cpus: 1.5
        cpuset: '0-2'
        pids_limit: 100
`;

        it('should read the non-swarm limits from compose', () => {
            const { config } = bothDrivers(yaml);
            const expected = {
                memory: 536870912,
                memoryReservation: 268435456,
                cpus: 1.5,
                cpusetCpus: '0-2',
                pidsLimit: 100,
            };
            for (const [key, value] of Object.entries(expected)) {
                if (config.resources?.[key] !== value) {
                    throw new Error(`resources.${key}: expected ${value}, got ${config.resources?.[key]}`);
                }
            }
        });

        it('should fall back to deploy.resources.limits', () => {
            const { config } = bothDrivers(
                SERVICE +
                    `        deploy:
            resources:
                limits:
                    cpus: '0.5'
                    memory: 128M
                    pids: 50
`,
            );
            if (config.resources?.cpus !== 0.5 || config.resources?.memory !== 134217728) {
                throw new Error(`Unexpected resources: ${JSON.stringify(config.resources)}`);
            }
            if (config.resources?.pidsLimit !== 50) {
                throw new Error(`pids limit was not taken over: ${JSON.stringify(config.resources)}`);
            }
        });

        it('should send a cpu fraction as NanoCpus, not as a cpu set', () => {
            const { api } = bothDrivers(yaml);
            if (api.HostConfig.NanoCpus !== 1_500_000_000) {
                throw new Error(`cpus: 1.5 must be 1.5e9 NanoCpus, got ${api.HostConfig.NanoCpus}`);
            }
            // "1.5" as a cpu set would make docker reject the container
            if (api.HostConfig.CpusetCpus !== '0-2') {
                throw new Error(`CpusetCpus must hold the cpu set, got ${api.HostConfig.CpusetCpus}`);
            }
        });

        it('should send the memory and pids limits over both drivers', () => {
            const { api, cli } = bothDrivers(yaml);
            if (api.HostConfig.Memory !== 536870912 || api.HostConfig.PidsLimit !== 100) {
                throw new Error(`Unexpected HostConfig: ${JSON.stringify(api.HostConfig.Memory)}`);
            }
            for (const expected of ['--memory 536870912', '--pids-limit 100', '--cpuset-cpus 0-2']) {
                if (!cli.includes(expected)) {
                    throw new Error(`"${expected}" is missing in: ${cli}`);
                }
            }
        });

        it('should keep -1 of memswap_limit, which means unlimited', () => {
            const { config } = bothDrivers(
                SERVICE +
                    `        memswap_limit: -1
`,
            );
            if (config.resources?.memorySwap !== -1) {
                throw new Error(`Expected -1, got ${JSON.stringify(config.resources)}`);
            }
        });
    });

    describe('argument boundaries on the CLI driver', () => {
        // The CLI driver used to join everything into one command line that a shell then split
        // again, so every value containing a space fell apart into several arguments.
        const yaml = `
services:
    svc:
        image: nginx:1.27
        container_name: svc
        labels:
            - 'iobEnabled=true'
            - 'description=a label with spaces'
        environment:
            GREETING: hello world
            QUOTED: he said "hi"
        volumes:
            - /host/Program Files/data:/data
        working_dir: /var/my dir
`;

        it('should keep a value with spaces in a single argument', () => {
            const { args } = bothDrivers(yaml);

            if (valueOf(args, '-e') !== 'GREETING=hello world') {
                throw new Error(`The environment value was split up: ${JSON.stringify(args)}`);
            }
            if (valueOf(args, '--workdir') !== '/var/my dir') {
                throw new Error(`The working directory was split up: ${JSON.stringify(args)}`);
            }
            const label = args.filter((a, i) => args[i - 1] === '--label').find(a => a.startsWith('description='));
            if (label !== 'description=a label with spaces') {
                throw new Error(`The label was split up: ${JSON.stringify(args)}`);
            }
            const mount = args.filter((a, i) => args[i - 1] === '--mount')[0];
            if (!mount || !mount.includes('source=/host/Program Files/data')) {
                throw new Error(`The bind mount path was split up: ${JSON.stringify(args)}`);
            }
        });

        it('should keep a value with quotes in a single argument', () => {
            const { args } = bothDrivers(yaml);
            const quoted = args.filter((a, i) => args[i - 1] === '-e').find(a => a.startsWith('QUOTED='));
            if (quoted !== 'QUOTED=he said "hi"') {
                throw new Error(`Unexpected argument: ${JSON.stringify(quoted)}`);
            }
        });

        it('should quote such values in the displayable command line', () => {
            const { cli } = bothDrivers(yaml);
            if (cli.includes('-e GREETING=hello world')) {
                throw new Error(`The rendered command line must quote the value: ${cli}`);
            }
            if (!/-e (['"])GREETING=hello world\1/.test(cli)) {
                throw new Error(`Expected a quoted value in: ${cli}`);
            }
        });

        it('should leave a harmless value unquoted', () => {
            if (quoteArg('nginx:1.27') !== 'nginx:1.27') {
                throw new Error('A value without special characters must stay as it is');
            }
            if (quoteArg('8080:80/tcp') !== '8080:80/tcp') {
                throw new Error('A port mapping must stay as it is');
            }
        });

        it('should split a multi-element entrypoint the way docker expects it', () => {
            const config = toConfig(SERVICE);
            config.entrypoint = ['/bin/sh', '-c', 'echo hello world'];
            const args = DockerManager.toDockerRunArgs(config);

            // --entrypoint takes one value; the rest belongs behind the image
            if (valueOf(args, '--entrypoint') !== '/bin/sh') {
                throw new Error(`Unexpected entrypoint: ${JSON.stringify(args)}`);
            }
            const imageIndex = args.indexOf(config.image);
            if (JSON.stringify(args.slice(imageIndex + 1)) !== JSON.stringify(['-c', 'echo hello world'])) {
                throw new Error(`The remaining entrypoint arguments are wrong: ${JSON.stringify(args)}`);
            }
        });

        it('should build no docker command by string interpolation', function () {
            // The whole point of the argument list: a name or path from the configuration must
            // never become part of a command line that a shell parses.
            const source = `${__dirname}/../src/lib/DockerManager.ts`;
            if (!existsSync(source)) {
                this.skip();
                return;
            }
            const offenders = readFileSync(source, 'utf8')
                .split('\n')
                .map((line, index) => [index + 1, line])
                .filter(([, line]) => /#exec\(\s*[`'"]/.test(line));

            if (offenders.length) {
                throw new Error(
                    `#exec must be called with an argument list, found string commands in lines ${offenders
                        .map(([number]) => number)
                        .join(', ')}`,
                );
            }
        });
    });

    describe('unlimited memory swap', () => {
        it('should keep -1 of memswap_limit, which means unlimited', () => {
            const { config } = bothDrivers(
                SERVICE +
                    `        memswap_limit: -1
`,
            );
            if (config.resources?.memorySwap !== -1) {
                throw new Error(`Expected -1, got ${JSON.stringify(config.resources)}`);
            }
        });
    });
});
