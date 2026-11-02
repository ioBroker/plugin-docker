const DockerPluginModule = require('../build/cjs/index.js');
const DockerManagerModule = require('../build/cjs/lib/DockerManager');
const DockerManagerOfOwnContainers = require('../build/cjs/lib/DockerManagerOfOwnContainers');

const DockerPlugin = DockerPluginModule.default || DockerPluginModule;
const DockerManager = DockerManagerModule.default || DockerManagerModule;
const Manager = DockerManagerOfOwnContainers.default || DockerManagerOfOwnContainers;

const NAMESPACE = 'alternatives-test.0';
const PREFIX = 'iob_alternatives_test_0';

function createLogger() {
    const logs = [];
    const logger = {
        silly: () => {},
        debug: () => {},
        info: text => logs.push(['info', text]),
        warn: text => logs.push(['warn', text]),
        error: text => logs.push(['error', text]),
    };
    return { logger, logs };
}

/**
 * Run fn against a fake docker that knows the given containers.
 *
 * The methods are replaced on the prototype, because the plugin creates its managers itself. That
 * also keeps every manager away from the real docker daemon - the CI runner has one.
 *
 * @param {object[]} containers what `containerList` answers
 * @param {Function} fn receives the list of docker calls, as `STOP <name>` and `CREATE <name>`
 * @param {Function} [init] replaces the detection of docker
 */
async function withFakeDocker(containers, fn, init) {
    const events = [];
    const fake = {
        containerList: async () => containers,
        containerStop: async name => {
            events.push(`STOP ${name}`);
            return { stdout: '', stderr: '' };
        },
        containerRun: async config => {
            events.push(`CREATE ${config.name}`);
            return { stdout: '', stderr: '' };
        },
        containerStart: async () => ({ stdout: '', stderr: '' }),
        containerInspect: async () => null,
        imageList: async () => ['cpu', 'gpu', 'foreign'].map(repository => ({ repository, tag: 'latest' })),
        imagePull: async () => ({ stdout: '', stderr: '' }),
        networkList: async () => [],
        networkCreate: async () => ({ stdout: '', stderr: '' }),
        networkConnect: async () => ({ stdout: '', stderr: '' }),
        volumeList: async () => [],
        volumeCreate: async () => ({ stdout: '', stderr: '' }),
    };
    const saved = Object.keys(fake).map(name => [name, Object.getOwnPropertyDescriptor(Manager.prototype, name)]);
    const originalInit = DockerManager.prototype.init;
    DockerManager.prototype.init =
        init ||
        async function () {
            this.installed = true;
            this.dockerVersion = 'fake';
        };
    Object.assign(Manager.prototype, fake);
    try {
        await fn(events);
    } finally {
        DockerManager.prototype.init = originalInit;
        for (const [name, descriptor] of saved) {
            if (descriptor) {
                Object.defineProperty(Manager.prototype, name, descriptor);
            } else {
                delete Manager.prototype[name];
            }
        }
    }
    return events;
}

function createPlugin(native, logger) {
    const plugin = new DockerPlugin({
        pluginScope: 'adapter',
        parentNamespace: `system.adapter.${NAMESPACE}`,
        pluginNamespace: `system.adapter.${NAMESPACE}.plugins.docker`,
        pluginLogNamespace: NAMESPACE,
        log: logger,
        iobrokerConfig: {},
        parentPackage: { name: 'iobroker.alternatives-test' },
        adapterDir: __dirname,
    });
    plugin.getObject = async () => ({ _id: `system.adapter.${NAMESPACE}`, native });
    return plugin;
}

function running(name, labels = { iobroker: NAMESPACE }) {
    return { id: name.slice(-12), names: name, status: 'running', labels };
}

function expectEvents(events, expected) {
    if (JSON.stringify(events) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(events)}`);
    }
}

describe('disabled services', () => {
    it('should stop the container of the service that was enabled before, then start the new one', async () => {
        // the user switched from the CPU variant to the GPU variant, both publish the same port
        const { logger } = createLogger();
        const events = await withFakeDocker([running(`${PREFIX}_cpu`)], async () => {
            const plugin = createPlugin({ cpu: false, gpu: true }, logger);
            await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
            await plugin.destroy();
        });

        // the order matters: the new container cannot publish the port while the old one holds it
        expectEvents(events, [`STOP ${PREFIX}_cpu`, `CREATE ${PREFIX}_gpu`]);
    });

    it('should stop the container when the instance runs no container at all', async () => {
        // the user switched from Docker to an external server: no service is enabled any more
        const { logger } = createLogger();
        let plugin;
        const events = await withFakeDocker([running(`${PREFIX}_cpu`)], async () => {
            plugin = createPlugin({ cpu: false, gpu: false }, logger);
            await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
        });

        expectEvents(events, [`STOP ${PREFIX}_cpu`]);
        if (plugin.getDockerManager() !== null) {
            throw new Error('Without an enabled service there is nothing to manage, getDockerManager() must stay null');
        }
        if (plugin.configurations.length) {
            throw new Error(`A disabled service is not managed, got ${JSON.stringify(plugin.configurations)}`);
        }
    });

    it('should leave a stopped container alone', async () => {
        const { logger } = createLogger();
        const events = await withFakeDocker([{ ...running(`${PREFIX}_cpu`), status: 'exited' }], async () => {
            const plugin = createPlugin({ cpu: false, gpu: false }, logger);
            await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
        });

        expectEvents(events, []);
    });

    it('should not stop a container that this instance did not create', async () => {
        const { logger } = createLogger();
        const events = await withFakeDocker(
            [running(`${PREFIX}_cpu`, {}), running(`${PREFIX}_gpu`, { iobroker: 'other.0' })],
            async () => {
                const plugin = createPlugin({ cpu: false, gpu: false }, logger);
                await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
            },
        );

        expectEvents(events, []);
    });

    it('should not touch a service without the iobEnabled label', async () => {
        // iobEnabled is an opt-in: only an explicit `false` stops a container, a missing label does not
        const { logger } = createLogger();
        const events = await withFakeDocker([running(`${PREFIX}_foreign`)], async () => {
            const plugin = createPlugin({ cpu: false, gpu: false }, logger);
            await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
        });

        expectEvents(events, []);
    });

    it('should keep starting the enabled service when the stop fails', async () => {
        const { logger, logs } = createLogger();
        const events = await withFakeDocker([running(`${PREFIX}_cpu`)], async events => {
            Manager.prototype.containerStop = async name => {
                events.push(`STOP ${name}`);
                throw new Error('no permission');
            };
            const plugin = createPlugin({ cpu: false, gpu: true }, logger);
            await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
            await plugin.destroy();
        });

        expectEvents(events, [`STOP ${PREFIX}_cpu`, `CREATE ${PREFIX}_gpu`]);
        if (!logs.find(([level, text]) => level === 'warn' && text.includes('no permission'))) {
            throw new Error(`The failed stop must be reported, got ${JSON.stringify(logs)}`);
        }
    });

    it('should not warn about a missing Docker when no service is enabled', async () => {
        // an adapter that offers Docker as one option among others must not complain on a host
        // without Docker, when the user did not select it
        const withoutDocker = async function () {
            this.installed = false;
            this.logDockerUnavailable('Docker is not installed. Please install Docker.');
        };

        const disabled = createLogger();
        await withFakeDocker(
            [],
            async () => {
                const plugin = createPlugin({ cpu: false, gpu: false }, disabled.logger);
                await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
            },
            withoutDocker,
        );
        if (disabled.logs.find(([level]) => level !== 'info')) {
            throw new Error(`Expected no warning, got ${JSON.stringify(disabled.logs)}`);
        }

        // but with an enabled service the user has to see it, as the container will not start
        const enabled = createLogger();
        await withFakeDocker(
            [],
            async () => {
                const plugin = createPlugin({ cpu: false, gpu: true }, enabled.logger);
                await plugin.init({ iobDockerComposeFiles: ['docker-compose-alternatives.yaml'] });
                await plugin.destroy();
            },
            withoutDocker,
        );
        if (!enabled.logs.find(([level, text]) => level === 'warn' && text.includes('not installed'))) {
            throw new Error(`Expected a warning, got ${JSON.stringify(enabled.logs)}`);
        }
    });
});
