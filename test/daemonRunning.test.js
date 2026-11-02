const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const DockerManagerModule = require('../build/cjs/lib/DockerManager');

const DockerManager = DockerManagerModule.default || DockerManagerModule;

/**
 * A Docker API that answers `/_ping` and `/version` like dockerd
 *
 * @returns the server, its port, the requests it got and its state: with `hang` set it accepts requests
 *   but never answers them, `abandoned` counts those whose connection the client closed
 */
async function fakeDockerApi() {
    const requests = [];
    const state = { hang: false, abandoned: 0 };
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        if (state.hang) {
            // never ended, so 'close' only comes when the client drops the connection
            res.on('close', () => state.abandoned++);
            return;
        }
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
    return { server, port: server.address().port, requests, state };
}

/**
 * Wait until a condition holds
 *
 * @param condition checked every 10 ms
 * @param timeoutMs give up after this many milliseconds
 * @returns whether the condition held in time
 */
async function waitFor(condition, timeoutMs = 2_000) {
    const end = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > end) {
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return true;
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

    it('gives up on a Docker API that accepts the ping but never answers, and cancels the request', async () => {
        const { server, port, state } = await fakeDockerApi();
        const pingTimeout = DockerManager.PING_TIMEOUT_MS;
        DockerManager.PING_TIMEOUT_MS = 300;
        try {
            const { manager, logs } = managerFor(port);
            await manager.isReady();
            state.hang = true;

            const start = Date.now();
            const info = await manager.getDockerDaemonInfo();

            // used to stay pending forever
            assert.equal(info.daemonRunning, false);
            assert.ok(Date.now() - start < 3_000, `took ${Date.now() - start} ms`);
            assert.match(logs.join('\n'), /no answer to \/_ping within 300 ms/);
            assert.ok(
                await waitFor(() => state.abandoned === 1),
                'the pending /_ping has to be cancelled, not left open',
            );
        } finally {
            DockerManager.PING_TIMEOUT_MS = pingTimeout;
            await stop(server);
        }
    });
});

/**
 * Lower the timeouts of the manager to 300 ms
 *
 * @returns restore() puts the defaults back
 */
function lowTimeouts() {
    const saved = { ping: DockerManager.PING_TIMEOUT_MS, startup: DockerManager.STARTUP_TIMEOUT_MS };
    DockerManager.PING_TIMEOUT_MS = 300;
    DockerManager.STARTUP_TIMEOUT_MS = 300;
    return {
        restore() {
            DockerManager.PING_TIMEOUT_MS = saved.ping;
            DockerManager.STARTUP_TIMEOUT_MS = saved.startup;
        },
    };
}

describe('init with a daemon that never answers', function () {
    this.timeout(10_000);

    it('gives up on the version of a Docker API that never answers, and cancels the request', async () => {
        const { server, port, state } = await fakeDockerApi();
        state.hang = true;
        const timeouts = lowTimeouts();
        try {
            const { manager, logs } = managerFor(port);
            const start = Date.now();
            // used to stay pending forever, and with it everything that waits for the manager
            await manager.isReady();

            assert.ok(Date.now() - start < 3_000, `took ${Date.now() - start} ms`);
            assert.match(logs.join('\n'), /no answer to \/version within 300 ms/);
            assert.match(logs.join('\n'), /The Docker API http:\/\/127\.0\.0\.1:\d+ does not answer/);
            assert.ok(
                await waitFor(() => state.abandoned === 1),
                'the pending /version has to be cancelled, not left open',
            );
            const info = await manager.getDockerDaemonInfo();
            assert.equal(info.daemonRunning, false);
            assert.equal(info.version, '');
        } finally {
            timeouts.restore();
            await stop(server);
        }
    });

    it('does not take a listener that never answers on a Docker API port for a Docker API', async () => {
        const sockets = new Set();
        let closed = 0;
        const server = net.createServer(socket => {
            sockets.add(socket);
            socket.on('close', () => closed++);
            // reads the request and never answers; without reading, the socket would not notice the client leaving
            socket.resume();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const timeouts = lowTimeouts();
        try {
            const start = Date.now();
            // used to stay pending forever: the probe only settled on 'end' or 'error'
            const isDockerApi = await DockerManager.isDockerApiRunningOnPort(server.address().port, '127.0.0.1');

            assert.equal(isDockerApi, false);
            assert.ok(Date.now() - start < 3_000, `took ${Date.now() - start} ms`);
            assert.ok(await waitFor(() => closed === 1), 'the probe has to close its connection');
        } finally {
            timeouts.restore();
            sockets.forEach(socket => socket.destroy());
            await new Promise(resolve => server.close(() => resolve()));
        }
    });

    it('gives up on "docker ps" of a daemon that never answers and assumes no sudo', async function () {
        if (process.platform === 'win32') {
            // the fake docker below is a shell script
            this.skip();
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
        fs.writeFileSync(
            path.join(dir, 'docker'),
            '#!/bin/sh\nif [ "$1" = "ps" ]; then exec sleep 30; fi\necho "Docker version 28.3.2, build fake"\n',
            { mode: 0o755 },
        );
        const { server, port } = await fakeDockerApi();
        const pathBefore = process.env.PATH;
        process.env.PATH = `${dir}${path.delimiter}${pathBefore}`;
        const timeouts = lowTimeouts();
        try {
            const { manager, logs } = managerFor(port);
            const start = Date.now();
            // used to stay pending until "docker ps" returned - with a hung daemon never
            await manager.isReady();

            assert.ok(Date.now() - start < 3_000, `took ${Date.now() - start} ms`);
            // missing permissions are reported at once, a timeout says nothing about them
            assert.equal(manager.needSudo, false);
            assert.match(logs.join('\n'), /"docker ps" did not finish within 300 ms/);
        } finally {
            process.env.PATH = pathBefore;
            timeouts.restore();
            await stop(server);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
