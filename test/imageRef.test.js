const assert = require('node:assert/strict');
const {
    imageInfoFromApi,
    imageInfoFromCli,
    imageMatches,
    imageRefKey,
    isDigestRef,
    normalizeImageRef,
    parseImageRef,
    pullableImageRef,
} = require('../build/cjs/lib/imageRef');
const DockerManagerModule = require('../build/cjs/lib/DockerManager');
const { reconcile } = require('./helpers/reconcile-harness');

const DockerManager = DockerManagerModule.default || DockerManagerModule;

const DIGEST = 'sha256:e7f6fab57bbcb1b6fa6f50dd3e8d0739fa9dbb23e8af61a671ac6536e0ae7d1e';
const OLD_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000001';

describe('image references', () => {
    it('splits name, tag and digest', () => {
        assert.deepEqual(parseImageRef('nginx'), { name: 'nginx', tag: undefined, digest: undefined });
        assert.deepEqual(parseImageRef('nginx:1.27'), { name: 'nginx', tag: '1.27', digest: undefined });
        assert.deepEqual(parseImageRef(`openthread/otbr@${DIGEST}`), {
            name: 'openthread/otbr',
            tag: undefined,
            digest: DIGEST,
        });
        assert.deepEqual(parseImageRef(`openthread/otbr:latest@${DIGEST}`), {
            name: 'openthread/otbr',
            tag: 'latest',
            digest: DIGEST,
        });
    });

    it('does not take the port of a registry for a tag', () => {
        assert.deepEqual(parseImageRef('localhost:5000/tools/app'), {
            name: 'localhost:5000/tools/app',
            tag: undefined,
            digest: undefined,
        });
        assert.deepEqual(parseImageRef('localhost:5000/tools/app:2'), {
            name: 'localhost:5000/tools/app',
            tag: '2',
            digest: undefined,
        });
        assert.equal(normalizeImageRef('localhost:5000/tools/app'), 'localhost:5000/tools/app:latest');
    });

    it('adds :latest only to references without tag and digest', () => {
        assert.equal(normalizeImageRef('nginx'), 'nginx:latest');
        assert.equal(normalizeImageRef(' nginx:1.27 '), 'nginx:1.27');
        assert.equal(normalizeImageRef(`openthread/otbr@${DIGEST}`), `openthread/otbr@${DIGEST}`);
    });

    it('pulls a digest without the tag', () => {
        assert.equal(pullableImageRef(`openthread/otbr:latest@${DIGEST}`), `openthread/otbr@${DIGEST}`);
        assert.equal(pullableImageRef(`openthread/otbr@${DIGEST}`), `openthread/otbr@${DIGEST}`);
        assert.equal(pullableImageRef('localhost:5000/app'), 'localhost:5000/app:latest');
        assert.equal(pullableImageRef('nginx:1.27'), 'nginx:1.27');
    });

    it('compares Docker Hub names in their short form, and a digest wins over a tag', () => {
        assert.equal(imageRefKey('nginx'), imageRefKey('docker.io/library/nginx:latest'));
        assert.equal(imageRefKey('openthread/otbr:latest'), imageRefKey('docker.io/openthread/otbr'));
        assert.equal(imageRefKey(`openthread/otbr:latest@${DIGEST}`), imageRefKey(`openthread/otbr@${DIGEST}`));
        assert.notEqual(imageRefKey(`openthread/otbr@${DIGEST}`), imageRefKey(`openthread/otbr@${OLD_DIGEST}`));
        assert.notEqual(imageRefKey('openthread/otbr'), imageRefKey(`openthread/otbr@${DIGEST}`));
        assert.ok(isDigestRef(`openthread/otbr@${DIGEST}`));
        assert.ok(!isDigestRef('openthread/otbr:latest'));
    });

    it('finds an image by any of its tags', () => {
        const info = { repository: 'influxdb', tag: '2.7', tags: ['influxdb:2.7', 'influxdb:2'], digests: [] };
        assert.ok(imageMatches(info, 'influxdb:2'));
        assert.ok(imageMatches(info, 'influxdb:2.7'));
        assert.ok(!imageMatches(info, 'influxdb'));
    });

    it('finds an image pulled by digest only', () => {
        const info = { repository: 'openthread/otbr', tag: '<none>', tags: [], digests: [`openthread/otbr@${DIGEST}`] };
        assert.ok(imageMatches(info, `openthread/otbr@${DIGEST}`));
        assert.ok(imageMatches(info, `docker.io/openthread/otbr:latest@${DIGEST}`));
        assert.ok(!imageMatches(info, `openthread/otbr@${OLD_DIGEST}`));
        assert.ok(!imageMatches(info, 'openthread/otbr:latest'));
    });

    it('still understands the ImageInfo of older versions (repository and tag only)', () => {
        assert.ok(imageMatches({ repository: 'nginx', tag: '1.27' }, 'nginx:1.27'));
        assert.ok(!imageMatches({ repository: '<none>', tag: '<none>' }, 'nginx:1.27'));
    });

    it('reads the image list of the API', () => {
        const info = imageInfoFromApi({
            Id: 'sha256:0123456789abcdef0123',
            RepoTags: ['localhost:5000/app:2', 'localhost:5000/app:latest'],
            RepoDigests: [`localhost:5000/app@${DIGEST}`],
            Created: 1700000000,
            Size: 42,
        });
        assert.equal(info.repository, 'localhost:5000/app');
        assert.equal(info.tag, '2');
        assert.deepEqual(info.tags, ['localhost:5000/app:2', 'localhost:5000/app:latest']);
        assert.equal(info.id, '0123456789ab');

        const byDigest = imageInfoFromApi({
            Id: 'sha256:0123456789abcdef0123',
            RepoTags: [],
            RepoDigests: [`openthread/otbr@${DIGEST}`],
            Created: 1700000000,
            Size: 42,
        });
        assert.equal(byDigest.repository, 'openthread/otbr');
        assert.equal(byDigest.tag, '<none>');

        const dangling = imageInfoFromApi({
            Id: 'sha256:0123456789abcdef0123',
            RepoTags: ['<none>:<none>'],
            RepoDigests: ['<none>@<none>'],
            Created: 1700000000,
            Size: 42,
        });
        assert.deepEqual([dangling.repository, dangling.tag, dangling.tags, dangling.digests], ['<none>', '<none>', [], []]);
    });

    it('reads the image list of the CLI', () => {
        const size = () => 7;
        const tagged = imageInfoFromCli(`nginx;1.27;${DIGEST};abc123;2026-01-01 10:00:00 +0100 CET;192MB`, size);
        assert.deepEqual(tagged.tags, ['nginx:1.27']);
        assert.deepEqual(tagged.digests, [`nginx@${DIGEST}`]);
        assert.equal(tagged.size, 7);
        assert.equal(tagged.createdSince, '2026-01-01 10:00:00 +0100 CET');

        const byDigest = imageInfoFromCli(`openthread/otbr;<none>;${DIGEST};abc123;2026-01-01;80MB`, size);
        assert.deepEqual(byDigest.tags, []);
        assert.ok(imageMatches(byDigest, `openthread/otbr@${DIGEST}`));

        const withPort = imageInfoFromCli('localhost:5000/app;2;<none>;abc123;2026-01-01;80MB', size);
        assert.ok(imageMatches(withPort, 'localhost:5000/app:2'));
        assert.deepEqual(withPort.digests, []);
    });
});

describe('images pinned to a digest', () => {
    const service = image => `
services:
    otbr:
        image: '${image}'
        container_name: otbr
        labels:
            - 'iobEnabled=true'
`;
    const pulledByDigest = [
        { repository: 'openthread/otbr', tag: '<none>', tags: [], digests: [`openthread/otbr@${DIGEST}`] },
    ];

    it('leaves a running container with the pinned image alone and does not pull', async () => {
        const { events, pulls } = await reconcile(service(`openthread/otbr@${DIGEST}`), { images: pulledByDigest });
        assert.deepEqual(events, []);
        assert.deepEqual(pulls, []);
    });

    it('pulls the image if only another digest is there', async () => {
        const { pulls } = await reconcile(service(`openthread/otbr@${OLD_DIGEST}`), { images: pulledByDigest });
        assert.deepEqual(pulls, [`openthread/otbr@${OLD_DIGEST}`]);
    });

    it('recreates the container when the pinned digest changes', async () => {
        const { events } = await reconcile(service(`openthread/otbr@${DIGEST}`), {
            images: pulledByDigest,
            mutate: inspect => {
                inspect.Config.Image = `openthread/otbr@${OLD_DIGEST}`;
            },
        });
        assert.ok(events.includes('RECREATE'), `expected RECREATE, got ${events.join(',')}`);
    });

    it('does not recreate a container whose image docker reports in another notation', async () => {
        const { events } = await reconcile(service(`openthread/otbr:latest@${DIGEST}`), {
            images: pulledByDigest,
            mutate: inspect => {
                inspect.Config.Image = `docker.io/openthread/otbr@${DIGEST}`;
            },
        });
        assert.deepEqual(events, []);
    });

    it('never updates a pinned image', async () => {
        const originalInit = DockerManager.prototype.init;
        DockerManager.prototype.init = async function () {};
        let manager;
        try {
            manager = new DockerManager({ logger: console, namespace: 'digest-test.0' });
        } finally {
            DockerManager.prototype.init = originalInit;
        }
        const pulls = [];
        manager.imageList = async () => pulledByDigest;
        manager.imagePull = async image => {
            pulls.push(image);
            return { stdout: '', stderr: '' };
        };
        assert.equal(await manager.imageUpdate(`openthread/otbr@${DIGEST}`), null);
        assert.deepEqual(pulls, []);
        await assert.rejects(manager.imageUpdate(`openthread/otbr@${OLD_DIGEST}`), /not found/);
    });
});
