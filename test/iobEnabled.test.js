const { readFileSync } = require('node:fs');
const composeFromYaml = require('../build/cjs/lib/parseDockerCompose');
const { composeToContainerConfigs } = require('../build/cjs/lib/compose2config');
const DockerPluginModule = require('../build/cjs/index.js');
const DockerManagerOfOwnContainers = require('../build/cjs/lib/DockerManagerOfOwnContainers');

const DockerPlugin = DockerPluginModule.default || DockerPluginModule;
const Manager = DockerManagerOfOwnContainers.default || DockerManagerOfOwnContainers;

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Run the plugin init against a compose file of the test directory and return the managed services.
 *
 * The manager's init() is stubbed out, because it would really talk to the docker daemon - the CI
 * runner has one - and create the networks and containers of the fixture.
 */
async function managedServices(composeFile) {
    const originalInit = Manager.prototype.init;
    Manager.prototype.init = async function () {};
    try {
        const plugin = new DockerPlugin({
            pluginScope: 'adapter',
            parentNamespace: 'system.adapter.enabled-test.0',
            pluginNamespace: 'system.adapter.enabled-test.0.plugins.docker',
            pluginLogNamespace: 'enabled-test.0',
            log: silentLogger,
            iobrokerConfig: {},
            parentPackage: { name: 'iobroker.enabled-test' },
            adapterDir: __dirname,
        });
        plugin.getObject = async () => ({ _id: 'system.adapter.enabled-test.0', native: {} });

        await plugin.init({ iobDockerComposeFiles: [composeFile] });

        return plugin.configurations.map(config => config.name);
    } finally {
        Manager.prototype.init = originalInit;
    }
}

describe('iobEnabled', () => {
    it('should convert the label to a boolean and leave it undefined when it is missing', () => {
        const yaml = readFileSync(`${__dirname}/docker-compose-enabled.yaml`, 'utf8');
        const configs = composeToContainerConfigs(composeFromYaml.default(yaml));
        const byName = Object.fromEntries(configs.map(c => [c.name, c.iobEnabled]));

        if (byName['explicit-true'] !== true || byName['explicit-false'] !== false) {
            throw new Error(`Explicit labels were not converted: ${JSON.stringify(byName)}`);
        }
        if (byName['no-label'] !== undefined || byName['other-labels'] !== undefined) {
            throw new Error(`A missing label must stay undefined: ${JSON.stringify(byName)}`);
        }
    });

    it('should manage a service that opts in with iobEnabled=true', async () => {
        const managed = await managedServices('docker-compose-enabled.yaml');

        if (!managed.includes('explicit-true')) {
            throw new Error(`iobEnabled=true must be managed, got ${JSON.stringify(managed)}`);
        }
    });

    it('should not manage a service without the iobEnabled label', async () => {
        const managed = await managedServices('docker-compose-enabled.yaml');

        // Managing a container is an explicit opt-in - a compose file may well contain services
        // that the plugin must keep its hands off
        for (const name of ['no-label', 'other-labels']) {
            if (managed.includes(name)) {
                throw new Error(`Service ${name} has no iobEnabled label and must not be managed`);
            }
        }
    });

    it('should not manage a service with iobEnabled=false', async () => {
        const managed = await managedServices('docker-compose-enabled.yaml');

        if (managed.includes('explicit-false')) {
            throw new Error(`iobEnabled=false must exclude the service, got ${JSON.stringify(managed)}`);
        }
    });

    it('should manage exactly the opted-in services', async () => {
        const managed = await managedServices('docker-compose-enabled.yaml');

        if (JSON.stringify(managed) !== JSON.stringify(['explicit-true'])) {
            throw new Error(`Expected only the opted-in service, got ${JSON.stringify(managed)}`);
        }
    });

    it('should accept any truthy value, not only the literal true', async () => {
        // The check is intentionally truthy: an adapter may store its setting as something other
        // than a boolean, e.g. `1`. Only a missing value or false must keep the service unmanaged.
        const managed = await managedServices('docker-compose-truthy.yaml');

        if (JSON.stringify(managed.sort()) !== JSON.stringify(['number-one', 'yaml-bool', 'yes-value'])) {
            throw new Error(`Truthy values must opt in, got ${JSON.stringify(managed)}`);
        }
    });
});
