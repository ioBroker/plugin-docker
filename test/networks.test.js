const composeFromYaml = require('../build/cjs/lib/parseDockerCompose');
const { composeToContainerConfigs } = require('../build/cjs/lib/compose2config');
const DockerManager = require('../build/cjs/lib/DockerManager');
const DockerManagerOfOwnContainers = require('../build/cjs/lib/DockerManagerOfOwnContainers');

const DM = DockerManager.default || DockerManager;
const Manager = DockerManagerOfOwnContainers.default || DockerManagerOfOwnContainers;

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Convert a compose snippet to the ContainerConfig of its first service */
function toConfig(yaml) {
    return composeToContainerConfigs(composeFromYaml.default(yaml))[0];
}

/** Convert and additionally apply the ioBroker naming rules, as the manager does before creating */
function toPrefixedConfig(yaml, namespace = 'eebus-go.0') {
    const manager = new Manager({ logger: silentLogger, namespace });
    const config = toConfig(yaml);
    const created = manager.normalizeContainerNetworks(config);
    return { config, created, manager };
}

function assertEqual(actual, expected, what) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

describe('networks', () => {
    describe('network_mode', () => {
        it('should apply host mode to the container', () => {
            const config = toConfig(`
version: '3.9'
services:
    my-service:
        image: my-image:latest
        network_mode: 'host'
`);
            assertEqual(config.networkMode, 'host', 'networkMode');
            assertEqual(DM.getDockerodeConfig(config).HostConfig.NetworkMode, 'host', 'HostConfig.NetworkMode');
            if (!DM.toDockerRun(config).includes('--network host')) {
                throw new Error(`docker run should contain "--network host": ${DM.toDockerRun(config)}`);
            }
        });

        it('should apply none and bridge mode', () => {
            assertEqual(toConfig('services:\n  a: {image: img, network_mode: none}\n').networkMode, 'none', 'none');
            assertEqual(
                toConfig('services:\n  a: {image: img, network_mode: bridge}\n').networkMode,
                'bridge',
                'bridge',
            );
        });

        it('should never prefix or create a network for reserved modes', () => {
            for (const mode of ['host', 'none', 'bridge']) {
                const { config, created } = toPrefixedConfig(`services:\n  a: {image: img, network_mode: ${mode}}\n`);
                assertEqual(config.networkMode, mode, `networkMode for ${mode}`);
                assertEqual(created, [], `created networks for ${mode}`);
            }
        });

        it('should prefix and create a custom network given as network_mode', () => {
            const { config, created } = toPrefixedConfig('services:\n  a: {image: img, network_mode: mynet}\n');
            assertEqual(config.networkMode, 'iob_eebus_go_0_mynet', 'networkMode');
            assertEqual(created, ['iob_eebus_go_0_mynet'], 'created networks');
        });
    });

    describe('container:/service: references', () => {
        it('should keep container:<name> and follow the prefix of the referenced container', () => {
            const { config, created } = toPrefixedConfig(
                "services:\n  a: {image: img, network_mode: 'container:other'}\n",
            );
            assertEqual(config.networkMode, 'container:iob_eebus_go_0_other', 'networkMode');
            assertEqual(config.networkContainer, 'iob_eebus_go_0_other', 'networkContainer');
            // a container reference is not a network and must not be created
            assertEqual(created, [], 'created networks');
        });

        it('should resolve the compose-only service:<name> form to the container of that service', () => {
            const config = toConfig(
                "services:\n  a: {image: img, network_mode: 'service:db'}\n  db: {image: db, container_name: mydb}\n",
            );
            assertEqual(config.networkMode, 'container:mydb', 'networkMode');
            assertEqual(config.networkContainer, 'mydb', 'networkContainer');
        });

        it('should fall back to the service name when the service has no container_name', () => {
            const config = toConfig("services:\n  a: {image: img, network_mode: 'service:db'}\n  db: {image: db}\n");
            assertEqual(config.networkMode, 'container:db', 'networkMode');
        });
    });

    describe('networks resolution', () => {
        it('should attach a network that is declared in the top-level networks block', () => {
            const config = toConfig(
                'services:\n  a: {image: img, networks: [backend]}\nnetworks:\n  backend: {driver: bridge}\n',
            );
            assertEqual(config.networks, [{ name: 'backend' }], 'networks');
            assertEqual(config.networkMode, 'backend', 'networkMode');
        });

        it('should keep the ioBroker shorthand `true` as a network name', () => {
            const config = toConfig('services:\n  a: {image: img, networks: [true]}\nnetworks:\n  true: {}\n');
            assertEqual(config.networks, [{ name: 'true' }], 'networks');

            // `true` addresses the shared default network of this instance
            const { config: prefixed, created } = toPrefixedConfig(
                'services:\n  a: {image: img, networks: [true]}\nnetworks:\n  true: {}\n',
            );
            assertEqual(prefixed.networkMode, 'iob_eebus_go_0', 'networkMode');
            assertEqual(created, ['iob_eebus_go_0'], 'created networks');
        });

        it('should keep option-less entries of the mapping form', () => {
            const config = toConfig(
                'services:\n  a:\n    image: img\n    networks:\n      front: {aliases: [www]}\n      back: {}\nnetworks:\n  front: {}\n  back: {}\n',
            );
            assertEqual(
                config.networks.map(n => n.name),
                ['front', 'back'],
                'network names',
            );
            assertEqual(config.networks[0].aliases, ['www'], 'aliases');
        });

        it('should use the real name of an external network and never create it', () => {
            const { config, created } = toPrefixedConfig(
                'services:\n  a: {image: img, networks: [ext]}\nnetworks:\n  ext: {external: true, name: real_net}\n',
            );
            assertEqual(config.networkMode, 'real_net', 'networkMode');
            assertEqual(created, [], 'created networks');
        });

        it('should leave the shared iobroker network unprefixed', () => {
            const { config } = toPrefixedConfig('services:\n  a: {image: img, networks: [iobroker]}\n');
            assertEqual(config.networkMode, 'iobroker', 'networkMode');
        });

        it('should create the container in the first network and connect the rest afterwards', () => {
            const { config, created } = toPrefixedConfig(
                'services:\n  a:\n    image: img\n    networks:\n      front: {aliases: [www]}\n      back: {}\nnetworks:\n  front: {}\n  back: {}\n',
            );
            assertEqual(config.networkMode, 'iob_eebus_go_0_front', 'networkMode');
            assertEqual(created, ['iob_eebus_go_0_front', 'iob_eebus_go_0_back'], 'created networks');
            assertEqual(
                DM.getSecondaryNetworks(config).map(n => n.name),
                ['iob_eebus_go_0_back'],
                'secondary networks',
            );

            // aliases belong to the network the container is created in
            assertEqual(
                DM.getDockerodeConfig(config).NetworkingConfig,
                { EndpointsConfig: { iob_eebus_go_0_front: { Aliases: ['www'] } } },
                'NetworkingConfig',
            );
            if (!DM.toDockerRun(config).includes('--network-alias www')) {
                throw new Error(`docker run should contain the alias: ${DM.toDockerRun(config)}`);
            }
        });

        it('should ignore networks when network_mode is given, as compose does', () => {
            const config = toConfig(
                "services:\n  a: {image: img, network_mode: host, networks: [backend]}\nnetworks:\n  backend: {}\n",
            );
            assertEqual(config.networkMode, 'host', 'networkMode');
            assertEqual(config.networks, undefined, 'networks');
        });
    });

    describe('idempotency', () => {
        it('should not prefix twice when the check runs repeatedly', () => {
            const samples = [
                "services:\n  a: {image: img, network_mode: 'container:other'}\n",
                'services:\n  a: {image: img, networks: [true]}\nnetworks:\n  true: {}\n',
                'services:\n  a:\n    image: img\n    networks:\n      front: {}\n      back: {}\nnetworks:\n  front: {}\n  back: {}\n',
            ];
            for (const yaml of samples) {
                const { config, manager } = toPrefixedConfig(yaml);
                const afterFirst = JSON.stringify(config);
                manager.normalizeContainerNetworks(config);
                manager.normalizeContainerNetworks(config);
                if (JSON.stringify(config) !== afterFirst) {
                    throw new Error(
                        `Repeated normalization changed the config:\n  ${afterFirst}\n  ${JSON.stringify(config)}`,
                    );
                }
            }
        });
    });
});
