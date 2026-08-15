/**
 * Exercises the dockerode path of containerRun()/containerRunAndWait() against a fake dockerode.
 *
 * Runs as a standalone script in a child process on purpose: the fake has to replace the dockerode
 * module before DockerManager requires it, and the CI runner has a real docker daemon that the
 * manager would otherwise talk to. It lives in this subdirectory so that mocha's default glob
 * (`./test/*.js`, not recursive) does not load it as a test file - it patches the module resolution
 * of the whole process and must not leak into the test run.
 *
 * Prints a single JSON line with the observations, which containerRun.test.js asserts on.
 */
const Module = require('node:module');
const path = require('node:path');

const calls = { created: [], started: [], runs: [], removed: [] };

class FakeDocker {
    version() {
        return Promise.resolve({ Version: '99.0', ApiVersion: '1.45' });
    }

    createContainer(config) {
        calls.created.push(config.name);
        return Promise.resolve({
            id: 'deadbeef',
            start: () => {
                calls.started.push(config.name);
                return Promise.resolve();
            },
        });
    }

    /** The real dockerode.run() attaches and resolves only when the container exits */
    run(image, _cmd, streams, options) {
        calls.runs.push(options && options.name);
        if (image === 'never-exits') {
            // a daemon container never exits, so this promise never settles
            return new Promise(() => {});
        }
        return new Promise(resolve => {
            setTimeout(() => {
                streams[0].write('total 0\ndrwxr-xr-x 2 root root 40 Jan 1 00:00 .\n');
                setTimeout(() => resolve([{ StatusCode: 0 }, {}]), 5);
            }, 5);
        });
    }

    getContainer(name) {
        return {
            remove: () => {
                calls.removed.push(name);
                return Promise.resolve();
            },
        };
    }
}

// Point every `require('dockerode')` at the fake before DockerManager is loaded
const fakePath = path.resolve(__dirname, 'fake-dockerode-module.js');
require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports: FakeDocker };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'dockerode' ? fakePath : originalResolve.call(this, request, ...rest);
};

const DockerManagerModule = require('../../build/cjs/lib/DockerManager');

const DockerManager = DockerManagerModule.default || DockerManagerModule;
const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function main() {
    // host + port makes init() take the dockerode branch without probing the local socket
    const manager = new DockerManager({
        logger: silentLogger,
        namespace: 'run-test.0',
        dockerApi: { host: '127.0.0.1', port: 1234, protocol: 'http' },
    });
    await manager.isReady();

    const result = {};

    // A daemon container must not be waited for - "never-exits" would hang in dockerode.run()
    const startedAt = Date.now();
    result.daemon = await DockerManager.withTimeout(
        manager.containerRun({ image: 'never-exits', name: 'iob_run_test_0_daemon' }),
        5_000,
        'containerRun still waits for the container to exit',
    );
    result.daemonMs = Date.now() - startedAt;

    // A short-lived helper must deliver its output
    result.helper = await manager.containerRunAndWait({
        image: 'alpine',
        name: 'iobroker_temp_ls_1',
        removeOnExit: true,
        command: ['ls', '-la', '/data'],
    });

    // A helper that never finishes must time out instead of blocking forever
    result.stuck = await manager.containerRunAndWait(
        { image: 'never-exits', name: 'iobroker_temp_stuck' },
        { timeoutMs: 300 },
    );

    result.calls = calls;
    process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
    process.stdout.write(JSON.stringify({ error: err.message }));
    process.exitCode = 1;
});
