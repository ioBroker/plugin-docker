/**
 * Drive one reconcile pass of DockerManagerOfOwnContainers against a fake docker.
 *
 * Lives in this subdirectory because mocha's default glob (`./test/*.js`) is not recursive - this
 * is a helper module, not a test file.
 *
 * The interesting question for the reconcile loop is not whether a container can be created, but
 * whether a container that already runs *with exactly the desired configuration* is left alone.
 * So `containerInspect` answers with an inspect that is derived from the very configuration the
 * manager holds at that moment - the manager normalizes it in place (name, network and volume
 * prefixes, env files), which is exactly the state a container created by it would report.
 *
 * A `mutate` callback lets a test change that answer to simulate a container that really differs.
 */
const composeFromYaml = require('../../build/cjs/lib/parseDockerCompose');
const { composeToContainerConfigs } = require('../../build/cjs/lib/compose2config');
const DockerManagerModule = require('../../build/cjs/lib/DockerManager');
const ManagerModule = require('../../build/cjs/lib/DockerManagerOfOwnContainers');

const DockerManager = DockerManagerModule.default || DockerManagerModule;
const Manager = ManagerModule.default || ManagerModule;

/** Build the inspect answer docker would give for a container created from `cfg` */
function inspectFor(cfg) {
    const name = typeof cfg.name === 'string' ? cfg.name : 'unnamed';
    const network = typeof cfg.networkMode === 'string' ? cfg.networkMode : 'bridge';

    return {
        Name: `/${name}`,
        Config: {
            Image: cfg.image,
            Cmd: null,
            Entrypoint: null,
            User: '',
            WorkingDir: '',
            Hostname: 'containerid',
            Domainname: '',
            Env: Object.entries(cfg.environment || {}).map(([k, v]) => `${k}=${v}`),
            Labels: cfg.labels || {},
            Tty: false,
            OpenStdin: false,
            AttachStdin: false,
            AttachStdout: false,
            AttachStderr: false,
            Volumes: null,
            StopSignal: cfg.stop?.signal || null,
            StopTimeout: cfg.stop?.gracePeriodSec ?? null,
            // docker echoes the healthcheck it was created with, in nanoseconds
            Healthcheck: DockerManager.getDockerodeConfig(cfg).Healthcheck,
        },
        HostConfig: {
            PublishAllPorts: false,
            PortBindings: Object.fromEntries(
                (cfg.ports || []).map(p => [
                    `${p.containerPort}/${p.protocol || 'tcp'}`,
                    [{ HostPort: String(p.hostPort), HostIp: p.hostIP || '' }],
                ]),
            ),
            Binds: null,
            ExtraHosts: null,
            Dns: cfg.dns?.servers || [],
            DnsSearch: cfg.dns?.search || [],
            DnsOptions: cfg.dns?.options || [],
            NetworkMode: network,
            RestartPolicy: { Name: cfg.restart?.policy || '', MaximumRetryCount: cfg.restart?.maxRetries || 0 },
            NanoCpus: cfg.resources?.cpus ? Math.round(cfg.resources.cpus * 1e9) : 0,
            CpuShares: cfg.resources?.cpuShares || 0,
            CpuQuota: cfg.resources?.cpuQuota || 0,
            CpuPeriod: cfg.resources?.cpuPeriod || 0,
            CpusetCpus: cfg.resources?.cpusetCpus || '',
            Memory: cfg.resources?.memory || 0,
            MemorySwap: cfg.resources?.memorySwap || 0,
            MemoryReservation: cfg.resources?.memoryReservation || 0,
            PidsLimit: cfg.resources?.pidsLimit ?? null,
            ShmSize: cfg.resources?.shmSize || 67108864,
            ReadonlyRootfs: !!cfg.readOnly,
            LogConfig: { Type: cfg.logging?.driver || 'json-file', Config: cfg.logging?.options || {} },
            Privileged: !!cfg.security?.privileged,
            CapAdd: null,
            CapDrop: null,
            UsernsMode: '',
            IpcMode: 'private',
            PidMode: '',
            SecurityOpt: null,
            GroupAdd: null,
            Sysctls: cfg.sysctls || null,
            Init: null,
        },
        Mounts: (cfg.mounts || []).map(m => ({
            Type: m.type,
            // docker reports the mount point of a named volume, not its name
            Source: m.type === 'volume' ? `/var/lib/docker/volumes/${m.source}/_data` : m.source,
            Destination: m.target,
            RW: !m.readOnly,
        })),
        NetworkSettings: {
            MacAddress: '',
            Networks: {
                [network]: { Aliases: null, IPAddress: '172.17.0.2', GlobalIPv6Address: '', DriverOpts: null },
            },
        },
    };
}

/**
 * Run one reconcile pass over the first (or named) service of a compose file.
 *
 * @param {string} yaml compose file content
 * @param {object} [options] options
 * @param {string} [options.service] which service to reconcile, default: the last one
 * @param {Function} [options.mutate] receives the inspect answer and may change it
 * @param {string} [options.adapterDir] adapter directory, for env_file resolution
 * @returns {Promise<{events: string[], logs: Array<[string, string]>, config: object}>}
 */
async function reconcile(yaml, options = {}) {
    const configs = composeToContainerConfigs(composeFromYaml.default(yaml));
    const cfg = options.service ? configs.find(c => c.name === options.service) : configs[configs.length - 1];
    if (!cfg) {
        throw new Error(`Service ${options.service} not found in the compose file`);
    }

    const events = [];
    const logs = [];
    const logger = {
        silly: () => {},
        debug: () => {},
        info: text => logs.push(['info', text]),
        warn: text => logs.push(['warn', text]),
        error: text => logs.push(['error', text]),
    };

    // Keep the manager away from the real docker daemon - CI runners have one
    const originalInit = DockerManager.prototype.init;
    DockerManager.prototype.init = async function () {
        this.installed = true;
        this.dockerVersion = 'fake';
    };

    const own = [];
    let manager;
    try {
        manager = new Manager({ logger, namespace: 'probe.0', adapterDir: options.adapterDir }, own);

        // The manager lists the containers *before* it prefixes the names of its own ones, so the
        // list has to answer with the name the container will have, not with the one from compose.
        const prefix = manager.getDefaultContainerName();
        const runningName =
            cfg.name === prefix || String(cfg.name).startsWith(`${prefix}_`) ? cfg.name : `${prefix}_${cfg.name}`;

        manager.containerList = async () => [{ id: 'abc', names: runningName, status: 'running' }];
        manager.imageList = async () => [
            { repository: cfg.image.split(':')[0], tag: cfg.image.split(':')[1] || 'latest' },
        ];
        manager.imagePull = async () => ({ stdout: '', stderr: '' });
        manager.networkList = async () => [{ name: 'iob_probe_0' }];
        manager.networkCreate = async () => ({ stdout: '', stderr: '' });
        manager.volumeList = async () =>
            (cfg.mounts || []).filter(m => m.type === 'volume').map(m => ({ name: m.source }));
        manager.volumeCreate = async () => ({ stdout: '', stderr: '' });
        manager.networkConnect = async () => ({ stdout: '', stderr: '' });
        manager.containerStart = async () => ({ stdout: '', stderr: '' });
        manager.containerRestart = async () => ({ stdout: '', stderr: '' });
        manager.containerRun = async () => {
            events.push('CREATE');
            return { stdout: '', stderr: '' };
        };
        manager.containerReCreate = async () => {
            events.push('RECREATE');
            return { stdout: '', stderr: '' };
        };
        manager.containerInspect = async () => {
            const inspect = inspectFor(cfg);
            return options.mutate ? options.mutate(inspect) || inspect : inspect;
        };

        own.push(cfg);
        await manager.isReady();
    } finally {
        DockerManager.prototype.init = originalInit;
    }

    return { events, logs, config: cfg };
}

module.exports = { reconcile, inspectFor };
