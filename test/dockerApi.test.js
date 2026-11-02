const assert = require('node:assert/strict');
const DockerPluginModule = require('../build/cjs/index.js');
const DockerManagerOfOwnContainers = require('../build/cjs/lib/DockerManagerOfOwnContainers');

const DockerPlugin = DockerPluginModule.default || DockerPluginModule;
const { resolveDockerApi } = DockerPluginModule;
const Manager = DockerManagerOfOwnContainers.default || DockerManagerOfOwnContainers;

const NAS = { host: '192.168.1.5', port: 2376, protocol: 'https', ca: 'CA', cert: 'CERT', key: 'KEY' };
const SYSTEM_DOCKER = {
    _id: 'system.docker',
    native: { hosts: { local: { host: '127.0.0.1', port: 2375 }, nas: NAS } },
};

/**
 * Resolve with a recording logger
 *
 * @param iobDockerApi value of the plugin config
 * @param systemDocker the object system.docker, undefined for none
 * @param instanceConfig native of the instance
 */
async function resolve(iobDockerApi, systemDocker, instanceConfig = {}) {
    const warnings = [];
    let asked = 0;
    const dockerApi = await resolveDockerApi({
        iobDockerApi,
        instanceConfig,
        instance: 3,
        getSystemDocker: async () => {
            asked++;
            return systemDocker;
        },
        log: { warn: text => warnings.push(text) },
    });
    return { dockerApi, warnings, asked };
}

describe('resolveDockerApi', () => {
    it('is exported by the CommonJS build as well', () => {
        assert.equal(typeof resolveDockerApi, 'function');
    });

    it('is the Docker of the host if no connection is configured, without reading system.docker', async () => {
        for (const iobDockerApi of [undefined, '', null]) {
            const { dockerApi, asked } = await resolve(iobDockerApi, SYSTEM_DOCKER);
            assert.equal(dockerApi, undefined);
            assert.equal(asked, 0);
        }
    });

    it('takes the connection of system.docker with the configured name', async () => {
        const { dockerApi, warnings } = await resolve('nas', SYSTEM_DOCKER);
        assert.deepEqual(dockerApi, NAS);
        assert.deepEqual(warnings, []);
    });

    it('resolves a template in the name with the instance config', async () => {
        const { dockerApi } = await resolve('${config.dockerApi}', SYSTEM_DOCKER, { dockerApi: 'nas' });
        assert.deepEqual(dockerApi, NAS);

        const { dockerApi: fallback } = await resolve('{{config.dockerApi}}', SYSTEM_DOCKER, { dockerApi: 'local' });
        assert.deepEqual(fallback, { host: '127.0.0.1', port: 2375 });
    });

    it('is the Docker of the host if the template resolves to nothing', async () => {
        const { dockerApi, asked } = await resolve('${config.dockerApi}', SYSTEM_DOCKER, {});
        assert.equal(dockerApi, undefined);
        assert.equal(asked, 0);
    });

    it('takes a connection object, with its templates resolved', async () => {
        const { dockerApi } = await resolve(
            { host: '${config.dockerHost}', port: '${config.dockerPort:-2375}', protocol: 'http' },
            undefined,
            { dockerHost: '10.0.0.7' },
        );
        assert.deepEqual(dockerApi, { host: '10.0.0.7', port: 2375, protocol: 'http' });
    });

    it('warns and is the Docker of the host if system.docker does not define the name', async () => {
        const unknown = await resolve('other', SYSTEM_DOCKER);
        assert.equal(unknown.dockerApi, undefined);
        assert.match(unknown.warnings.join(), /Cannot find docker configuration for other/);

        // used to throw: system.docker without hosts
        const noHosts = await resolve('nas', { _id: 'system.docker', native: {} });
        assert.equal(noHosts.dockerApi, undefined);
        assert.match(noHosts.warnings.join(), /Cannot find docker configuration for nas/);

        const missing = await resolve('nas', null);
        assert.equal(missing.dockerApi, undefined);
        assert.match(missing.warnings.join(), /Cannot find system.docker object/);
    });

    it('takes nothing from the prototype of the hosts', async () => {
        for (const name of ['__proto__', 'constructor', 'toString']) {
            const { dockerApi } = await resolve(name, SYSTEM_DOCKER);
            assert.equal(dockerApi, undefined, name);
        }
    });
});

describe('DockerPlugin with iobDockerApi', () => {
    /**
     * Run the plugin init and return the dockerApi its manager got.
     *
     * The manager's init() is stubbed out, as it would really talk to Docker.
     *
     * @param pluginConfig the plugin config of io-package.json
     * @param native native of the instance
     */
    async function managerDockerApi(pluginConfig, native) {
        const originalInit = Manager.prototype.init;
        Manager.prototype.init = async function () {};
        try {
            const silent = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
            const plugin = new DockerPlugin({
                pluginScope: 'adapter',
                parentNamespace: 'system.adapter.api-test.0',
                pluginNamespace: 'system.adapter.api-test.0.plugins.docker',
                pluginLogNamespace: 'api-test.0',
                log: silent,
                iobrokerConfig: {},
                parentPackage: { name: 'iobroker.api-test' },
                adapterDir: __dirname,
            });
            plugin.getObject = async id =>
                id === 'system.docker' ? SYSTEM_DOCKER : { _id: 'system.adapter.api-test.0', native };

            await plugin.init(pluginConfig);

            return plugin.getDockerManager().dockerApi;
        } finally {
            Manager.prototype.init = originalInit;
        }
    }

    it('runs the containers on the connection a template in iobDockerApi selects', async () => {
        const dockerApi = await managerDockerApi(
            { iobDockerComposeFiles: ['docker-compose-enabled.yaml'], iobDockerApi: '${config.dockerApi}' },
            { dockerApi: 'nas' },
        );
        assert.deepEqual(dockerApi, NAS);
    });

    it('runs the containers on the connection named in iobDockerApi', async () => {
        const dockerApi = await managerDockerApi(
            { iobDockerComposeFiles: ['docker-compose-enabled.yaml'], iobDockerApi: 'nas' },
            {},
        );
        assert.deepEqual(dockerApi, NAS);
    });

    it('resolves templates in iobDockerComposeFiles', async () => {
        const dockerApi = await managerDockerApi(
            { iobDockerComposeFiles: ['docker-compose-${config.variant}.yaml'], iobDockerApi: 'nas' },
            { variant: 'enabled' },
        );
        // a manager exists only if the compose file was found and has a managed service
        assert.deepEqual(dockerApi, NAS);
    });

    it('leaves the resolved connection in the plugin config, where adapters read it', async () => {
        const pluginConfig = {
            iobDockerComposeFiles: ['docker-compose-enabled.yaml'],
            iobDockerApi: '${config.dockerApi}',
        };
        await managerDockerApi(pluginConfig, { dockerApi: 'nas' });
        assert.deepEqual(pluginConfig.iobDockerApi, NAS);

        const unknown = { iobDockerComposeFiles: ['docker-compose-enabled.yaml'], iobDockerApi: 'other' };
        await managerDockerApi(unknown, {});
        assert.equal('iobDockerApi' in unknown, false);
    });
});
