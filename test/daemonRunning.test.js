const assert = require('node:assert/strict');
const http = require('node:http');
const DockerManagerModule = require('../build/cjs/lib/DockerManager');

const DockerManager = DockerManagerModule.default || DockerManagerModule;

/**
 * A Docker API that answers `/_ping` and `/version` like dockerd
 *
 * @returns the server, its port and the requests it got
 */
async function fakeDockerApi() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        res.setHeader('Api-Version', '1.51');
        if (req.url.endsWith('/_ping')) {
            res.setHeader('Content-Type', 'text/plain');
            res.end('OK');
        } else if (req.url.endsWith('/version')) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ Version: '28.3.2', ApiVersion: '1.51' }));
        } else {
            res.statusCode = 404;
            res.end('{}');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port, requests };
}

/**
 * Stop the server, also its open keep-alive connections
 *
 * @param server the server
 */
function stop(server) {
    server.closeAllConnections?.();
    return new Promise(resolve => server.close(() => resolve()));
}

/**
 * A port nothing listens on
 */
async function closedPort() {
    const { server, port } = await fakeDockerApi();
    await stop(server);
    return port;
}

/** A quiet manager for this Docker API that records what it logs */
function managerFor(port) {
    const logs = [];
    const record = text => logs.push(text);
    const manager = new DockerManager({
        dockerApi: { host: '127.0.0.1', port, protocol: 'http' },
        logger: { silly: record, debug: record, info: record, warn: record, error: record },
        namespace: 'daemon-test.0',
        quiet: true,
    });
    return { manager, logs };
}

describe('getDockerDaemonInfo', function () {
    this.timeout(10_000);

    it('reports a configured Docker API that answers as running', async () => {
        const { server, port, requests } = await fakeDockerApi();
        try {
            const { manager } = managerFor(port);
            const info = await manager.getDockerDaemonInfo();

            assert.equal(info.daemonRunning, true);
            assert.equal(info.driver, 'http');
            assert.match(info.version, /28\.3\.2/);
            assert.ok(
                requests.some(url => url.endsWith('/_ping')),
                `the daemon has to be asked, got ${requests.join()}`,
            );
        } finally {
            await stop(server);
        }
    });

    it('reports a configured Docker API that does not answer as not running', async () => {
        const { manager, logs } = managerFor(await closedPort());
        const info = await manager.getDockerDaemonInfo();

        // used to be true: a configured API counted as running without being asked
        assert.equal(info.daemonRunning, false);
        assert.equal(info.version, '');
        // names the API instead of "not installed" or "run iob fix"
        assert.match(logs.join('\n'), /The Docker API http:\/\/127\.0\.0\.1:\d+ does not answer/);
        assert.doesNotMatch(logs.join('\n'), /iob fix|Please install Docker/);
    });

    it('notices a Docker API that is gone since the manager was created', async () => {
        const { server, port } = await fakeDockerApi();
        const { manager } = managerFor(port);
        await manager.isReady();
        assert.equal((await manager.getDockerDaemonInfo()).daemonRunning, true);

        await stop(server);

        assert.equal((await manager.getDockerDaemonInfo()).daemonRunning, false);
    });
});
