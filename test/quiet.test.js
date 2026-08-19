const DockerManagerModule = require('../build/cjs/lib/DockerManager');

const DockerManager = DockerManagerModule.default || DockerManagerModule;

/** A logger that remembers what was written on which level */
function recordingLogger() {
    const calls = { silly: [], debug: [], info: [], warn: [], error: [] };
    return {
        calls,
        logger: {
            silly: text => calls.silly.push(text),
            debug: text => calls.debug.push(text),
            info: text => calls.info.push(text),
            warn: text => calls.warn.push(text),
            error: text => calls.error.push(text),
        },
    };
}

/**
 * Build a manager without letting it probe the host.
 *
 * The constructor starts init(), which looks for the docker socket, the API ports and the CLI - on
 * a machine with a running daemon (the CI runner has one) nothing would be logged at all. The
 * message is triggered directly instead, so the test only covers the routing by level.
 */
function managerWithoutInit(options) {
    const originalInit = DockerManager.prototype.init;
    DockerManager.prototype.init = async function () {};
    try {
        return new DockerManager(options);
    } finally {
        DockerManager.prototype.init = originalInit;
    }
}

const MESSAGE = 'Docker is not installed. Please install Docker.';

describe('quiet', () => {
    it('should report a missing docker on warn level by default', () => {
        const { calls, logger } = recordingLogger();
        const manager = managerWithoutInit({ logger, namespace: 'quiet-test.0' });

        manager.logDockerUnavailable(MESSAGE);

        if (calls.warn.length !== 1 || calls.warn[0] !== MESSAGE) {
            throw new Error(`Without quiet the message must be a warning, got ${JSON.stringify(calls)}`);
        }
        if (calls.debug.length) {
            throw new Error(`Without quiet nothing must go to debug, got ${JSON.stringify(calls.debug)}`);
        }
    });

    it('should report a missing docker on debug level when quiet is set', () => {
        const { calls, logger } = recordingLogger();
        const manager = managerWithoutInit({ logger, namespace: 'quiet-test.0', quiet: true });

        manager.logDockerUnavailable(MESSAGE);

        if (calls.warn.length || calls.error.length) {
            throw new Error(`A quiet manager must not warn, got ${JSON.stringify(calls)}`);
        }
        if (calls.debug.length !== 1 || calls.debug[0] !== MESSAGE) {
            throw new Error(`The message must stay available on debug, got ${JSON.stringify(calls.debug)}`);
        }
    });

    it('should keep the error level of the daemon check when not quiet, and lower it when quiet', () => {
        const loud = recordingLogger();
        managerWithoutInit({ logger: loud.logger, namespace: 'quiet-test.0' }).logDockerUnavailable(
            'Docker is not installed: unit',
            'error',
        );
        if (loud.calls.error.length !== 1) {
            throw new Error(`Without quiet the level must be kept, got ${JSON.stringify(loud.calls)}`);
        }

        const quiet = recordingLogger();
        managerWithoutInit({ logger: quiet.logger, namespace: 'quiet-test.0', quiet: true }).logDockerUnavailable(
            'Docker is not installed: unit',
            'error',
        );
        if (quiet.calls.error.length || quiet.calls.debug.length !== 1) {
            throw new Error(`A quiet manager must lower the error too, got ${JSON.stringify(quiet.calls)}`);
        }
    });
});
