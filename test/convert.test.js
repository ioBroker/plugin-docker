const { readFileSync } = require('node:fs');
const composeFromYaml = require('../build/cjs/lib/parseDockerCompose');
const { composeToContainerConfigs } = require('../build/cjs/lib/compose2config');
const { parseField, walkTheConfig } = require('../build/cjs/lib/templates');

const sqlConfig = {
    dockerMysql: {
        enabled: false,
        bind: '127.0.0.1',
        stopIfInstanceStopped: true,
        port: '3306',
        autoImageUpdate: true,
        rootPassword: 'root_iobroker',
        shmSize: 128,
    },
    dockerPhpMyAdmin: {
        enabled: false,
        bind: '0.0.0.0',
        stopIfInstanceStopped: true,
        port: '8080',
        autoImageUpdate: true,
    },
};
const influxConfig = {
    dockerInflux: {
        enabled: false,
        bind: '127.0.0.1',
        stopIfInstanceStopped: true,
        port: '8086',
        autoImageUpdate: true,
    },
    dockerGrafana: {
        enabled: false,
        bind: '0.0.0.0',
        stopIfInstanceStopped: true,
        port: '3000',
        autoImageUpdate: true,
        adminSecurityPassword: 'iobroker',
        serverRootUrl: '',
        plugins: [],
        usersAllowSignUp: true,
    },
};
const yamlSql = readFileSync(`${__dirname}/docker-compose-sql.yaml`, 'utf8');
const yamlInflux = readFileSync(`${__dirname}/docker-compose-influx.yaml`, 'utf8');

describe('convert', () => {
    it('it should replace templates directly in YAML', () => {
        const parsedYaml = parseField(yamlSql, sqlConfig, { instance: 1 });
        if (parsedYaml.includes('{{') || parsedYaml.includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        console.log(parsedYaml);
    });
    it('it should replace templates in object', () => {
        const composeWithTemplates = composeFromYaml.default(yamlSql, { instance: 1 });
        const compose = walkTheConfig(composeWithTemplates, sqlConfig, { instance: 1 });
        if (JSON.stringify(compose, null, 2).includes('{{') || JSON.stringify(compose, null, 2).includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        console.log(JSON.stringify(compose, null, 2));
    });
    it('it should convert SQL compose to 2 configs', () => {
        const composeWithTemplates = composeFromYaml.default(yamlSql);
        const compose = walkTheConfig(composeWithTemplates, sqlConfig, { instance: 1 });
        const configs = composeToContainerConfigs(compose);
        if (JSON.stringify(configs, null, 2).includes('{{') || JSON.stringify(configs, null, 2).includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        if (configs[0].iobEnabled !== false) {
            throw new Error('Label iobEnabled should be removed');
        }
        if (!configs[0].iobStopOnUnload) {
            throw new Error('Label iobStopOnUnload should exists');
        }
        if (!configs[0].mounts[0].iobBackup) {
            throw new Error('Label iobBackup should exists');
        }
        if (configs[0].resources.shmSize !== 134217728) {
            throw new Error(`Label shm_size should exists: ${JSON.stringify(configs, null, 2)}`);
        }

        console.log(JSON.stringify(compose, null, 2));
    });
    it('it should convert influxdb to 2 configs', () => {
        const composeWithTemplates = composeFromYaml.default(yamlInflux);
        const compose = walkTheConfig(composeWithTemplates, influxConfig, { instance: 1 });
        const configs = composeToContainerConfigs(compose);
        if (JSON.stringify(configs, null, 2).includes('{{') || JSON.stringify(configs, null, 2).includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        if (configs[0].iobEnabled !== false) {
            throw new Error('Label iobEnabled should be removed');
        }
        if (!configs[0].iobStopOnUnload) {
            throw new Error('Label iobStopOnUnload should exists');
        }
        if (!configs[0].mounts[0].iobBackup) {
            throw new Error('Label iobBackup should exists');
        }

        if (!configs[1].mounts[0].iobAutoCopyFrom) {
            throw new Error('Label iobAutoCopyFrom should exists');
        }
        if (configs[1].mounts[0].iobAutoCopyFromForce !== undefined) {
            throw new Error('Label iobAutoCopyFromForce should not exists');
        }
        if (!configs[1].mounts[1].iobAutoCopyFrom) {
            throw new Error('Label iobAutoCopyFrom should exists');
        }
        if (configs[1].mounts[1].iobAutoCopyFromForce === undefined) {
            throw new Error('Label iobAutoCopyFromForce should exists');
        }

        if (configs[1].environment.GF_INSTANCE !== "1") {
            throw new Error('Environment GF_INSTANCE should be set');
        }

        console.log(JSON.stringify(configs, null, 2));
    });
});
