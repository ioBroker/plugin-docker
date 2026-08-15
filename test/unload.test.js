const { PluginBase } = require('@iobroker/plugin-base');
const DockerPluginModule = require('../build/cjs/index.js');
const DockerManagerOfOwnContainers = require('../build/cjs/lib/DockerManagerOfOwnContainers');

const DockerPlugin = DockerPluginModule.default || DockerPluginModule;
const Manager = DockerManagerOfOwnContainers.default || DockerManagerOfOwnContainers;

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Build a manager without letting it touch docker.
 *
 * The constructor kicks off init(), which checks the own containers - on a machine with a running
 * docker daemon that would really create networks and containers. Passing an empty array and
 * filling it only after init() finished keeps the test side effect free, because the manager keeps
 * the reference to that very array.
 */
async function managerWithContainers(containers) {
    const own = [];
    const manager = new Manager({ logger: silentLogger, namespace: 'unload-test.0' }, own);
    await manager.isReady();
    own.push(...containers);
    return manager;
}

describe('unload', () => {
    describe('DockerPlugin.destroy', () => {
        it('should override the no-op of PluginBase', () => {
            // PluginBase.destroy() resolves to true without doing anything, so a missing override
            // means the containers are never stopped on unload
            if (DockerPlugin.prototype.destroy === PluginBase.prototype.destroy) {
                throw new Error('DockerPlugin does not override destroy(), containers are never stopped');
            }
        });

        it('should stop the containers of the manager and report success', async () => {
            // Keep the manager away from docker - see managerWithContainers()
            const originalInit = Manager.prototype.init;
            Manager.prototype.init = async function () {};

            const stopped = [];
            try {
                const plugin = new DockerPlugin({
                    pluginScope: 'adapter',
                    parentNamespace: 'system.adapter.unload-test.0',
                    pluginNamespace: 'system.adapter.unload-test.0.plugins.docker',
                    pluginLogNamespace: 'unload-test.0',
                    log: silentLogger,
                    iobrokerConfig: {},
                    parentPackage: { name: 'iobroker.unload-test' },
                    adapterDir: __dirname,
                });
                plugin.getObject = async () => ({ _id: 'system.adapter.unload-test.0', native: {} });

                await plugin.init({ iobDockerComposeFiles: ['docker-compose-unload.yaml'] });

                const manager = plugin.getDockerManager();
                if (!manager) {
                    throw new Error('No docker manager was created');
                }
                manager.containerStop = async (name, options) => {
                    stopped.push({ name, options });
                    return { stdout: '', stderr: '' };
                };

                const result = await plugin.destroy();

                if (result !== true) {
                    throw new Error(`destroy() must resolve to true, got ${JSON.stringify(result)}`);
                }
                if (plugin.getDockerManager() !== null) {
                    throw new Error('The manager should be released after destroy()');
                }
            } finally {
                Manager.prototype.init = originalInit;
            }

            const names = stopped.map(s => s.name).sort();
            if (JSON.stringify(names) !== JSON.stringify(['second-stopper', 'stopper'])) {
                throw new Error(`Expected both iobStopOnUnload containers, got ${JSON.stringify(names)}`);
            }
        });

        it('should not fail when no manager was created', async () => {
            const plugin = new DockerPlugin({
                pluginScope: 'adapter',
                parentNamespace: 'system.adapter.unload-test.0',
                pluginNamespace: 'system.adapter.unload-test.0.plugins.docker',
                pluginLogNamespace: 'unload-test.0',
                log: silentLogger,
                iobrokerConfig: {},
                parentPackage: { name: 'iobroker.unload-test' },
                adapterDir: __dirname,
            });

            if ((await plugin.destroy()) !== true) {
                throw new Error('destroy() must resolve to true even without a manager');
            }
        });
    });

    describe('DockerManagerOfOwnContainers.destroy', () => {
        it('should only stop containers labeled with iobStopOnUnload', async () => {
            const stopped = [];
            const manager = await managerWithContainers([
                { name: 'keep', image: 'i' },
                { name: 'keep-explicit', image: 'i', iobStopOnUnload: false },
                { name: 'stop-me', image: 'i', iobStopOnUnload: true },
                { name: 'disabled', image: 'i', iobStopOnUnload: true, iobEnabled: false },
            ]);
            manager.containerStop = async name => {
                stopped.push(name);
                return { stdout: '', stderr: '' };
            };

            await manager.destroy();

            if (JSON.stringify(stopped) !== JSON.stringify(['stop-me'])) {
                throw new Error(`Expected only "stop-me" to be stopped, got ${JSON.stringify(stopped)}`);
            }
        });

        it('should skip the verification round trips, as the process may be killed within a second', async () => {
            const options = [];
            const manager = await managerWithContainers([{ name: 'stop-me', image: 'i', iobStopOnUnload: true }]);
            manager.containerStop = async (_name, opts) => {
                options.push(opts);
                return { stdout: '', stderr: '' };
            };

            await manager.destroy();

            if (!options[0] || options[0].skipVerification !== true) {
                throw new Error(`containerStop must be called with skipVerification, got ${JSON.stringify(options)}`);
            }
        });

        it('should stop the containers in parallel', async () => {
            const startedAt = [];
            const manager = await managerWithContainers([
                { name: 'a', image: 'i', iobStopOnUnload: true },
                { name: 'b', image: 'i', iobStopOnUnload: true },
                { name: 'c', image: 'i', iobStopOnUnload: true },
            ]);
            manager.containerStop = async () => {
                startedAt.push(Date.now());
                await new Promise(resolve => setTimeout(resolve, 60));
                return { stdout: '', stderr: '' };
            };

            const start = Date.now();
            await manager.destroy();
            const elapsed = Date.now() - start;

            // sequential would need ~180 ms for three containers
            if (elapsed > 150) {
                throw new Error(`Containers were stopped sequentially: ${elapsed} ms for 3 x 60 ms`);
            }
            if (Math.max(...startedAt) - Math.min(...startedAt) > 50) {
                throw new Error('The stops did not start at the same time');
            }
        });

        it('should keep stopping the other containers when one stop fails', async () => {
            const stopped = [];
            const manager = await managerWithContainers([
                { name: 'broken', image: 'i', iobStopOnUnload: true },
                { name: 'fine', image: 'i', iobStopOnUnload: true },
            ]);
            manager.containerStop = async name => {
                if (name === 'broken') {
                    throw new Error('container not found');
                }
                stopped.push(name);
                return { stdout: '', stderr: '' };
            };

            await manager.destroy();

            if (JSON.stringify(stopped) !== JSON.stringify(['fine'])) {
                throw new Error(`A failing stop must not abort the others, got ${JSON.stringify(stopped)}`);
            }
        });
    });
});
