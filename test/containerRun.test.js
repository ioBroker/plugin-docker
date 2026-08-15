const { execFile } = require('node:child_process');
const DockerManagerModule = require('../build/cjs/lib/DockerManager');

const DockerManager = DockerManagerModule.default || DockerManagerModule;
const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Run the dockerode scenarios in a child process - see fake-dockerode-run.js for the why */
function runFakeDockerodeScenarios() {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [`${__dirname}/helpers/fake-dockerode-run.js`], (err, stdout) => {
            if (err && !stdout) {
                return reject(err);
            }
            try {
                resolve(JSON.parse(stdout));
            } catch {
                reject(new Error(`Unexpected output: ${stdout}`));
            }
        });
    });
}

/** A manager instance that never touches docker - only the pure parts are exercised */
function offlineManager() {
    const manager = Object.create(DockerManager.prototype);
    manager.log = silentLogger;
    manager.installed = true;
    return manager;
}

describe('containerRun', () => {
    describe('dockerode path', () => {
        let scenarios;

        before(async function () {
            this.timeout(30_000);
            scenarios = await runFakeDockerodeScenarios();
            if (scenarios.error) {
                throw new Error(scenarios.error);
            }
        });

        it('should start a daemon container without waiting for it to exit', () => {
            // The bug: dockerode.run() resolves only on container exit, which never happens for a
            // daemon - the adapter start hung forever on the very first run
            if (scenarios.daemonMs > 2_000) {
                throw new Error(`containerRun took ${scenarios.daemonMs} ms, it must not wait for the exit`);
            }
            if (scenarios.daemon.stderr) {
                throw new Error(`containerRun failed: ${scenarios.daemon.stderr}`);
            }
        });

        it('should create and start the container instead of running dockerode.run()', () => {
            const { calls } = scenarios;
            if (!calls.created.includes('iob_run_test_0_daemon') || !calls.started.includes('iob_run_test_0_daemon')) {
                throw new Error(`Expected createContainer + start, got ${JSON.stringify(calls)}`);
            }
            if (calls.runs.includes('iob_run_test_0_daemon')) {
                throw new Error('containerRun must not use dockerode.run() for a daemon container');
            }
        });

        it('should return the output of a short-lived container from containerRunAndWait', () => {
            if (!scenarios.helper.stdout.includes('drwxr-xr-x')) {
                throw new Error(`Expected the container output, got ${JSON.stringify(scenarios.helper)}`);
            }
            if (!scenarios.calls.runs.includes('iobroker_temp_ls_1')) {
                throw new Error('containerRunAndWait must use dockerode.run() to collect the output');
            }
        });

        it('should time out and clean up a helper container that never finishes', () => {
            if (!/did not finish within/.test(scenarios.stuck.stderr)) {
                throw new Error(`Expected a timeout error, got ${JSON.stringify(scenarios.stuck)}`);
            }
            if (!scenarios.calls.removed.includes('iobroker_temp_stuck')) {
                throw new Error('A container that timed out has to be removed, removeOnExit never fires for it');
            }
        });
    });

    describe('CLI path', () => {
        it('should detach a daemon container', () => {
            const args = DockerManager.toDockerRun({ image: 'grpc', name: 'iob_x_0_svc' });

            if (!/(^|\s)-d(\s|$)/.test(args)) {
                throw new Error(`A daemon container has to be detached: ${args}`);
            }
        });

        it('should not detach a container whose output is needed', () => {
            // `docker run -d` prints the container ID instead of the command output, which would
            // silently feed garbage into parseLsLong()
            const args = DockerManager.toDockerRun({
                image: 'alpine',
                name: 'iobroker_temp_ls_1',
                removeOnExit: true,
                command: ['ls', '-la', '/data'],
                detach: false,
            });

            if (/(^|\s)-d(\s|$)/.test(args)) {
                throw new Error(`A container whose output is read must not be detached: ${args}`);
            }
            if (!args.includes('--rm')) {
                throw new Error(`A short-lived container should be removed on exit: ${args}`);
            }
        });
    });

    describe('volume helpers', () => {
        it('should read a directory listing through containerRunAndWait', async () => {
            const manager = offlineManager();
            let usedRun = false;
            const seen = [];
            manager.containerRun = async () => {
                usedRun = true;
                return { stdout: 'Container deadbeef started', stderr: '' };
            };
            manager.containerRunAndWait = async config => {
                seen.push(config.command);
                return { stdout: 'total 0\n-rw-r--r-- 1 root root 4 Jan 1 00:00 a.txt\n', stderr: '' };
            };

            const entries = await manager.volumeDir('myvol');

            if (usedRun) {
                throw new Error('volumeDir must not use containerRun - it would not capture the output');
            }
            if (!Array.isArray(entries) || !entries.length) {
                throw new Error(`Expected parsed entries, got ${JSON.stringify(entries)}`);
            }
            if (JSON.stringify(seen[0]) !== JSON.stringify(['ls', '-la', '/data'])) {
                throw new Error(`Unexpected command: ${JSON.stringify(seen)}`);
            }
        });

        it('should read a file through containerRunAndWait', async () => {
            const manager = offlineManager();
            let usedRun = false;
            manager.containerRun = async () => {
                usedRun = true;
                return { stdout: 'Container deadbeef started', stderr: '' };
            };
            manager.containerRunAndWait = async () => ({ stdout: 'file content', stderr: '' });

            const content = await manager.volumeFile('myvol', 'some.txt');

            if (usedRun) {
                throw new Error('volumeFile must not use containerRun - it would not capture the output');
            }
            if (content !== 'file content') {
                throw new Error(`Expected the file content, got ${JSON.stringify(content)}`);
            }
        });
    });

    describe('withTimeout', () => {
        it('should pass the value through when the promise is fast enough', async () => {
            const value = await DockerManager.withTimeout(Promise.resolve('done'), 1_000, 'too slow');

            if (value !== 'done') {
                throw new Error(`Expected the resolved value, got ${JSON.stringify(value)}`);
            }
        });

        it('should reject when the promise never settles', async () => {
            let message;
            try {
                await DockerManager.withTimeout(new Promise(() => {}), 50, 'too slow');
            } catch (e) {
                message = e.message;
            }
            if (message !== 'too slow') {
                throw new Error(`Expected a timeout rejection, got ${JSON.stringify(message)}`);
            }
        });
    });
});
