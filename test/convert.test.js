const { readFileSync } = require('node:fs');
const composeFromYaml = require('../build/lib/parseDockerCompose');
const { composeToContainerConfigs } = require('../build/lib/compose2config');
const { parseField, walkTheConfig } = require('../build/lib/templates');

const sqlConfig = {
    dockerMysql: {
        enabled: false,
        bind: '127.0.0.1',
        stopIfInstanceStopped: true,
        port: '3306',
        autoImageUpdate: true,
        rootPassword: 'root_iobroker',
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
        const parsedYaml = parseField(yamlSql, sqlConfig);
        if (parsedYaml.includes('{{') || parsedYaml.includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        console.log(parsedYaml);
    });
    it('it should replace templates in object', () => {
        const composeWithTemplates = composeFromYaml.default(yamlSql);
        const compose = walkTheConfig(composeWithTemplates, sqlConfig);
        if (JSON.stringify(compose, null, 2).includes('{{') || JSON.stringify(compose, null, 2).includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        console.log(JSON.stringify(compose, null, 2));
    });
    it('it should convert SQL compose to 2 configs', () => {
        const composeWithTemplates = composeFromYaml.default(yamlSql);
        const configs = composeToContainerConfigs(composeWithTemplates);
        const compose = walkTheConfig(configs, sqlConfig);
        if (JSON.stringify(compose, null, 2).includes('{{') || JSON.stringify(compose, null, 2).includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        if (compose[0].iobEnabled !== false) {
            throw new Error('Label iobEnabled should be removed');
        }
        if (!compose[0].iobStopOnUnload) {
            throw new Error('Label iobStopOnUnload should exists');
        }
        if (!compose[0].mounts[0].iobBackup) {
            throw new Error('Label iobBackup should exists');
        }

        console.log(JSON.stringify(compose, null, 2));
    });
    it('it should convert influxdb to 2 configs', () => {
        const composeWithTemplates = composeFromYaml.default(yamlInflux);
        const configs = composeToContainerConfigs(composeWithTemplates);
        const compose = walkTheConfig(configs, influxConfig);
        if (JSON.stringify(compose, null, 2).includes('{{') || JSON.stringify(compose, null, 2).includes('${')) {
            throw new Error('Not all templates were replaced');
        }
        if (compose[0].iobEnabled !== false) {
            throw new Error('Label iobEnabled should be removed');
        }
        if (!compose[0].iobStopOnUnload) {
            throw new Error('Label iobStopOnUnload should exists');
        }
        if (!compose[0].mounts[0].iobBackup) {
            throw new Error('Label iobBackup should exists');
        }

        if (!compose[1].mounts[1].iobCopyVolume) {
            throw new Error('Label iobCopyVolume should exists');
        }

        console.log(JSON.stringify(compose, null, 2));
    });
});
