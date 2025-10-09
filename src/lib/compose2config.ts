/* ============== Helpers ============== */

import { cleanUndefined, type ComposeService, type ComposeTop, type StringMap } from './parseDockerCompose';
import type {
    ContainerConfig,
    DeviceMapping,
    DNSConfig,
    EnvVar,
    Healthcheck,
    HostMapping,
    LabelMap,
    NetworkAttachment,
    PortBinding,
    Restart,
    VolumeMount,
} from '../types';

type Duration = `${number}ns` | `${number}us` | `${number}ms` | `${number}s` | `${number}m` | `${number}h`;

const isObject = (v: any): v is Record<string, any> => v && typeof v === 'object' && !Array.isArray(v);

function normalizeEnv(env?: ComposeService['environment']): EnvVar | undefined {
    if (!env) {
        return undefined;
    }
    if (Array.isArray(env)) {
        const out: EnvVar = {};
        for (const item of env) {
            const i = item.indexOf('=');
            if (i === -1) {
                out[item] = '';
            } else {
                out[item.slice(0, i)] = item.slice(i + 1);
            }
        }
        return out;
    }
    const out: EnvVar = {};
    for (const [k, v] of Object.entries(env)) {
        out[k] = v as any;
    }
    return out;
}

// "8080:80/tcp" | "80" | {target:80,published:8080,protocol:'tcp'}
function mapPorts(ports?: ComposeService['ports']): PortBinding[] | undefined {
    if (!ports || ports.length === 0) {
        return undefined;
    }
    const out: PortBinding[] = [];
    for (const p of ports) {
        if (typeof p === 'string') {
            // Parse "<host>[:hostPort]:containerPort[/proto]"  OR "containerPort[/proto]"
            const [left, proto] = p.split('/');
            const parts = left.split(':');
            if (parts.length === 1) {
                // "80" - only container port
                const containerPort = Number(parts[0]);
                if (!isNaN(containerPort)) {
                    out.push({ containerPort: containerPort, protocol: (proto as 'tcp' | 'udp') ?? 'tcp' });
                }
            } else if (parts.length === 2) {
                // "8080:80" - hostPort:containerPort
                const hostPort = Number(parts[0]);
                const containerPort = Number(parts[1]);
                if (!isNaN(hostPort) && !isNaN(containerPort)) {
                    out.push({ hostPort, containerPort, protocol: (proto as 'tcp' | 'udp') ?? 'tcp' });
                }
            } else if (parts.length === 3) {
                // "192.168.0.1:8080:80" - host:hostPort:containerPort
                const host = parts[0];
                const hostPort = Number(parts[1]);
                const containerPort = Number(parts[2]);
                if (host && !isNaN(hostPort) && !isNaN(containerPort)) {
                    out.push({
                        hostPort,
                        containerPort,
                        protocol: (proto as 'tcp' | 'udp') ?? 'tcp',
                        hostIP: host,
                    });
                }
            }
        } else {
            out.push({
                hostPort: p.published,
                containerPort: p.target,
                protocol: p.protocol ?? 'tcp',
            });
        }
    }
    return out;
}

// "hostPath:containerPath:ro" | "volName:containerPath" | object mount
function mapVolumes(
    vols?: ComposeService['volumes'],
    globalVolumes?: Record<
        string,
        {
            driver?: string;
            driver_opts?: StringMap;
            external?: boolean | { name: string };
            labels?: StringMap | string[];
        }
    >,
): {
    mounts?: VolumeMount[];
    tmpfs?: ContainerConfig['tmpfs'];
} {
    const res: { mounts?: VolumeMount[]; tmpfs?: ContainerConfig['tmpfs'] } = {};
    if (!vols?.length) {
        return res;
    }

    const mounts: VolumeMount[] = [];
    const tmpfs: NonNullable<ContainerConfig['tmpfs']> = [];

    for (const v of vols) {
        if (typeof v === 'string' && globalVolumes?.[v]) {
            // todo
        } else if (typeof v === 'string') {
            // parse "src:dst[:mode]"
            const segs = v.split(':');
            if (segs.length >= 2) {
                const [src, dst, mode] = segs;
                mounts.push({
                    type: src.startsWith('/') || src.startsWith('./') || src.startsWith('../') ? 'bind' : 'volume',
                    source: src,
                    target: dst,
                    // can't distinguish bind/volume reliably in short form; omit type
                    readOnly: mode?.includes('ro') ? true : undefined,
                });
            } else if (segs.length === 1) {
                // anonymous volume: ":/path" not present; keep as volume with only target?
                // Compose short form with single path means bind of current dir? Rare; ignore.
            }
        } else {
            const m: VolumeMount = {
                source: v.source ?? '',
                target: v.target,
                type: v.type as 'bind' | 'volume' | 'tmpfs' | 'npipe' | 'image',
                readOnly: v.read_only ?? undefined,
            };
            if (v.type === 'tmpfs') {
                tmpfs.push({ target: v.target, size: v.tmpfs?.size, mode: v.tmpfs?.mode });
            } else {
                // If the source is missing for named anonymous volume, keep empty string (manager can resolve)
                mounts.push(m);
            }
        }
    }

    if (mounts.length) {
        res.mounts = mounts;
    }
    if (tmpfs.length) {
        res.tmpfs = tmpfs;
    }
    return res;
}

function duration2ms(d?: Duration): number | undefined {
    if (d == null) {
        return undefined;
    }
    if (typeof d === 'number') {
        return d;
    }
    // crude parser: supports 1h, 5m, 30s; if plain number, assume seconds
    const m = String(d).match(/^(\d+)(ns|us|ms|s|m|h)?$/);
    if (!m) {
        return undefined;
    }
    const n = Number(m[1]);
    const u = m[2] || 's';
    switch (u) {
        case 'h':
            return n * 3_600_000;
        case 'm':
            return n * 60_000;
        case 's':
            return n * 1000;
        case 'ms':
            return n;
        case 'ns':
            return Math.ceil(n / 1_000_000);
        default:
            return undefined; // ignore ns/us
    }
}

function mapDevices(devs?: ComposeService['devices']): DeviceMapping[] | undefined {
    if (!devs || devs.length === 0) {
        return undefined;
    }
    const out: DeviceMapping[] = [];
    for (const d of devs) {
        if (typeof d === 'string') {
            // "/dev/video0:/dev/video0:rwm" or "/dev/video0"
            const segs = d.split(':');
            if (segs.length === 1) {
                out.push({ hostPath: segs[0] });
            } else if (segs.length === 2) {
                out.push({ hostPath: segs[0], containerPath: segs[1] });
            } else {
                out.push({ hostPath: segs[0], containerPath: segs[1], permissions: segs[2] });
            }
        } else {
            out.push({
                hostPath: d.source,
                containerPath: d.target,
                permissions: d.permissions,
            });
        }
    }
    return out;
}

function mapExtraHosts(e?: ComposeService['extra_hosts']): HostMapping[] | string[] | undefined {
    if (!e) {
        return undefined;
    }
    if (Array.isArray(e)) {
        return e.slice();
    }
    const out: HostMapping[] = [];
    for (const [host, ip] of Object.entries(e)) {
        out.push({ host, ip });
    }
    return out;
}

function mapDNS(svc: ComposeService): DNSConfig | undefined {
    const servers = svc.dns?.length ? svc.dns : undefined;
    const search = svc.dns_search?.length ? svc.dns_search : undefined;
    const options = svc.dns_opt?.length ? svc.dns_opt : undefined;
    if (!servers && !search && !options) {
        return undefined;
    }
    return { servers, search, options };
}

function mapHealthcheck(h?: ComposeService['healthcheck']): Healthcheck | undefined {
    if (!h) {
        return undefined;
    }
    return {
        test: h.test as string | string[] | ['NONE'],
        interval: duration2ms(h.interval),
        timeout: duration2ms(h.timeout),
        retries: h.retries,
        startPeriod: duration2ms(h.start_period),
    } as Healthcheck;
}

function mapRestart(r?: ComposeService['restart']): Restart | undefined {
    if (!r) {
        return undefined;
    }
    if (r.startsWith('on-failure')) {
        return {
            policy: 'on-failure',
        };
    }
    return {
        policy: r as 'no' | 'always' | 'unless-stopped',
    };
}

function parseDurationToSeconds(d?: string): number | undefined {
    if (!d) {
        return undefined;
    }
    // crude parser: supports 1h, 5m, 30s; if plain number, assume seconds
    const m = String(d).match(/^(\d+)(ns|us|ms|s|m|h)?$/);
    if (!m) {
        return undefined;
    }
    const n = Number(m[1]);
    const u = m[2] || 's';
    switch (u) {
        case 'h':
            return n * 3600;
        case 'm':
            return n * 60;
        case 's':
            return n;
        case 'ms':
            return Math.ceil(n / 1000);
        default:
            return undefined; // ignore ns/us
    }
}

function normalizeLabels(labels?: ComposeService['labels']): LabelMap | undefined {
    if (!labels) {
        return undefined;
    }
    if (Array.isArray(labels)) {
        const out: LabelMap = {};
        for (const l of labels) {
            const i = l.indexOf('=');
            if (i === -1) {
                out[l] = '';
            } else {
                out[l.slice(0, i)] = l.slice(i + 1);
            }
        }
        return out;
    }
    const out: LabelMap = {};
    for (const [k, v] of Object.entries(labels)) {
        out[k] = String(v);
    }
    return out;
}

function mapNetworks(
    n?: ComposeService['networks'],
    globalNetworks?: Record<
        string,
        {
            driver?: string;
            driver_opts?: StringMap;
            external?: boolean | { name: string };
            attachable?: boolean;
            enable_ipv6?: boolean;
            ipam?: {
                driver?: string;
                config?: Array<{ subnet?: string; gateway?: string; ip_range?: string }>;
                options?: StringMap;
            };
            labels?: StringMap | string[];
        }
    >,
): NetworkAttachment[] | undefined {
    if (!n) {
        return undefined;
    }
    const out: NetworkAttachment[] = [];
    if (Array.isArray(n)) {
        for (const item of n) {
            if (typeof item === 'string' && globalNetworks?.[item]) {
                // Just network name, and defined in global networks
                // todo
            } else if (typeof item === 'string') {
                out.push({ name: item });
            } else {
                out.push({
                    name: item.name,
                    aliases: item.aliases,
                    ipv4Address: item.ipv4_address,
                    ipv6Address: item.ipv6_address,
                });
            }
        }
    } else if (isObject(n)) {
        // Map string-map form: { netA: {}, netB: { aliases: [...] } }
        for (const [name, cfg] of Object.entries(n)) {
            if (cfg == null) {
                out.push({ name });
            } else if (isObject(cfg)) {
                out.push({
                    name,
                    aliases: (cfg as any).aliases,
                    ipv4Address: (cfg as any).ipv4_address,
                    ipv6Address: (cfg as any).ipv6_address,
                });
            } else {
                out.push({ name });
            }
        }
    }
    return out.length ? out : undefined;
}

/* ============== Main converter ============== */

export function composeServiceToContainerConfig(serviceName: string | undefined, compose: ComposeTop): ContainerConfig {
    const svc = compose.services?.[serviceName || ''];
    if (!svc) {
        throw new Error(`Service ${serviceName} not found in compose file`);
    }
    const env = normalizeEnv(svc.environment);
    const ports = mapPorts(svc.ports);
    const { mounts, tmpfs } = mapVolumes(svc.volumes, compose.volumes);
    const devices = mapDevices(svc.devices);
    const extraHosts = mapExtraHosts(svc.extra_hosts);
    const dns = mapDNS(svc);
    const healthcheck = mapHealthcheck(svc.healthcheck);
    const restart = mapRestart(svc.restart);
    const labels = normalizeLabels(svc.labels);
    const networks = mapNetworks(svc.networks, compose.networks);

    // Build mapping
    let build: ContainerConfig['build'] | undefined;
    if (svc.build) {
        if (typeof svc.build === 'string') {
            build = { context: svc.build };
        } else if (isObject(svc.build)) {
            build = {
                context: svc.build.context,
                dockerfile: svc.build.dockerfile,
                args: svc.build.args as EnvVar | undefined,
                target: svc.build.target,
                cacheFrom: svc.build.cache_from,
                labels: normalizeLabels(svc.build.labels),
            };
        }
    }

    const labelsWithoutIobSettings = { ...labels };
    // remove iob labels from normal labels
    delete labelsWithoutIobSettings?.iobEnabled;
    delete labelsWithoutIobSettings?.iobStopOnUnload;
    delete labelsWithoutIobSettings?.iobAutoImageUpdate;
    delete labelsWithoutIobSettings?.iobMonitoringEnabled;
    delete labelsWithoutIobSettings?.iobBackup;
    delete labelsWithoutIobSettings?.iobCopyVolumes;
    delete labelsWithoutIobSettings?.iobWaitForReady;
    const iobBackup = labels?.iobBackup?.split(',').map(m => m.trim());
    if (iobBackup?.length) {
        mounts?.forEach(m => {
            const source = m.source === true ? 'true' : m.source;
            if (source && iobBackup.includes(source)) {
                m.iobBackup = true;
            }
        });
    }
    const iobCopyVolumes = labels?.iobCopyVolumes?.split(',').map(m => {
        const parts = m.trim().split('=>');
        return {
            source: parts[0].trim(),
            target: parts[1]?.trim() || parts[0].trim(),
        };
    });
    if (iobCopyVolumes) {
        mounts?.forEach(m => {
            const source = m.source === true ? 'true' : m.source;
            const copyInstruction = iobCopyVolumes.find(c => c.target === source);
            if (copyInstruction) {
                m.iobCopyVolume = copyInstruction.source;
            }
        });
    }

    const cfg: ContainerConfig = {
        iobEnabled: labels?.iobEnabled !== 'false', // default true
        iobStopOnUnload: labels?.iobStopOnUnload === 'true', // default false
        iobAutoImageUpdate: labels?.iobAutoImageUpdate === 'true', // default false
        iobMonitoringEnabled: labels?.iobMonitoringEnabled === 'true', // default false
        iobWaitForReady:
            labels?.iobWaitForReady === 'true' ? true : labels?.iobWaitForReady === 'false' ? false : undefined, // default false

        name: svc.container_name || serviceName,
        image: svc.image || (build ? `${serviceName}:latest` : 'image:latest'),

        // runtime basics
        command: svc.command,
        entrypoint: svc.entrypoint,
        user: svc.user,
        workdir: svc.working_dir,
        hostname: svc.hostname,
        domainname: svc.domainname,
        // some compose variants use mac_address
        macAddress: (svc as any).mac_address,

        environment: env,
        envFile: svc.env_file ? (Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file]) : undefined,
        labels: labelsWithoutIobSettings,

        tty: svc.tty,
        stdinOpen: svc.stdin_open,

        ports,
        expose: svc.expose,

        mounts,
        devices,

        extraHosts,
        dns,

        networks,

        healthcheck,
        restart,

        logging: svc.logging
            ? {
                  driver: svc.logging.driver,
                  options: svc.logging.options,
              }
            : undefined,

        security: {
            privileged: svc.privileged,
            apparmor: svc.security_opt?.find(o => o.startsWith('apparmor='))?.slice(10),
            seccomp: svc.security_opt?.find(o => o.startsWith('seccomp='))?.slice(8),
            noNewPrivileges: svc.security_opt?.includes('no-new-privileges'),
        },

        sysctls: svc.sysctls,

        dependsOn: svc.depends_on,

        stop: {
            gracePeriodSec: parseDurationToSeconds(svc.stop_grace_period),
            signal: svc.stop_signal,
        },

        tmpfs,

        readOnly: svc.read_only,

        build,
    };

    return cleanUndefined(cfg) as ContainerConfig;
}

export function composeToContainerConfigs(compose: ComposeTop): ContainerConfig[] {
    const res: ContainerConfig[] = [];
    if (!compose.services) {
        return res;
    }

    for (const name of Object.keys(compose.services)) {
        res.push(composeServiceToContainerConfig(name, compose));
    }
    return res;
}
