import yaml from 'js-yaml';

/* Reuse the types you defined previously */
type Duration = `${number}ns` | `${number}us` | `${number}ms` | `${number}s` | `${number}m` | `${number}h`;
type StrOrStrArr = string | string[];
type KV = Record<string, string>;
export type StringMap = Record<string, string>;

export type RestartPolicy = 'no' | 'always' | 'unless-stopped' | `on-failure${'' | `:${number}`}`;

export interface ComposeHealthcheck {
    test: StrOrStrArr | ['NONE'];
    interval?: Duration;
    timeout?: Duration;
    retries?: number;
    start_period?: Duration;
}

export interface ComposeBuild {
    context?: string;
    dockerfile?: string;
    args?: KV;
    target?: string;
    network?: string;
    shm_size?: string | number;
    labels?: StringMap;
    cache_from?: string[];
    cache_to?: Array<{ type: 'inline' | 'local' | 'registry' | 'gha'; [k: string]: any }>;
    extra_hosts?: string[] | StringMap;
}

export interface ComposeResources {
    limits?: {
        cpus?: number | string;
        memory?: string | number;
        pids?: number;
    };
    reservations?: {
        cpus?: number | string;
        memory?: string | number;
        devices?: Array<{ capabilities: string[] }>;
    };
}

export interface ComposeLogging {
    driver?: 'json-file' | 'local' | 'syslog' | 'journald' | 'gelf' | 'fluentd' | 'awslogs' | 'splunk' | 'none';
    options?: KV;
}

export interface ComposeDeploy {
    mode?: 'replicated' | 'global';
    replicas?: number;
    restart_policy?: {
        condition?: 'none' | 'on-failure' | 'any';
        delay?: Duration;
        max_attempts?: number;
        window?: Duration;
    };
    resources?: ComposeResources;
    labels?: StringMap | string[];
    placement?: {
        constraints?: string[];
        preferences?: Array<{ spread: string }>;
    };
    update_config?: {
        parallelism?: number;
        delay?: Duration;
        failure_action?: 'continue' | 'rollback' | 'pause';
        monitor?: Duration;
        max_failure_ratio?: number;
        order?: 'stop-first' | 'start-first';
    };
    rollback_config?: ComposeDeploy['update_config'];
}

export interface ComposeVolumeMount {
    type?: 'volume' | 'bind' | 'tmpfs' | 'npipe';
    source?: string;
    target: string;
    read_only?: boolean;
    consistency?: 'consistent' | 'cached' | 'delegated';
    bind?: { create_host_path?: boolean; propagation?: string };
    volume?: { nocopy?: boolean };
    tmpfs?: { size?: number; mode?: number };
}

export interface ComposeService {
    container_name?: string;
    image?: string;
    build?: ComposeBuild | string;
    command?: StrOrStrArr;
    entrypoint?: StrOrStrArr;

    user?: string | number;
    working_dir?: string;
    hostname?: string;
    domainname?: string;

    environment?: StringMap | string[];
    env_file?: string | string[];

    labels?: StringMap | string[];

    ports?: Array<string | { target: number; published?: number; protocol?: 'tcp' | 'udp'; mode?: 'host' | 'ingress' }>;

    expose?: Array<number | string>;
    volumes?: Array<string | ComposeVolumeMount>;
    devices?: Array<string | { source: string; target?: string; permissions?: string }>;

    extra_hosts?: string[] | StringMap;

    dns?: string[];
    dns_search?: string[];
    dns_opt?: string[];

    networks?:
        | Array<string | { name: string; aliases?: string[]; ipv4_address?: string; ipv6_address?: string }>
        | StringMap;

    healthcheck?: ComposeHealthcheck;

    restart?: RestartPolicy;

    tty?: boolean;
    stdin_open?: boolean;

    depends_on?:
        | string[]
        | Record<string, { condition?: 'service_started' | 'service_healthy' | 'service_completed_successfully' }>;

    stop_grace_period?: Duration;
    stop_signal?: string;

    logging?: ComposeLogging;

    security_opt?: string[];
    privileged?: boolean;
    read_only?: boolean;
    shm_size?: string | number;
    sysctls?: StringMap;

    deploy?: ComposeDeploy;

    x_extra?: Record<string, any>;
}

export interface ComposeTop {
    /** Name of the Docker API to use. If not set, the system default will be used. */
    iobDockerApi?:
        | {
              host: string;
              port: number;
              protocol: 'http' | 'https';
              ca?: string;
              cert?: string;
              key?: string;
          }
        | string; // ioBroker setting;
    iobDockerComposeFiles?: string[]; // ioBroker setting - path to the compose file

    version?: '3.9' | '3.8' | '3.7' | '3.6' | '3.5' | '3.4' | '3.3' | '3.2' | '3.1' | '3';
    services?: Record<string, ComposeService>;
    networks?: Record<
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
    >;
    volumes?: Record<
        string,
        {
            driver?: string;
            driver_opts?: StringMap;
            external?: boolean | { name: string };
            labels?: StringMap | string[];
        }
    >;
    secrets?: Record<string, { file?: string; external?: boolean | { name: string }; labels?: StringMap | string[] }>;
    configs?: Record<string, { file?: string; external?: boolean | { name: string }; labels?: StringMap | string[] }>;
    [xKey: `x-${string}`]: any;
}

/* -----------------------------
 * Normalizers & helpers
 * -----------------------------*/

function isObject(x: any): x is Record<string, any> {
    return x && typeof x === 'object' && !Array.isArray(x);
}

function arrify<T>(x: T | T[] | undefined): T[] | undefined {
    if (x == null) {
        return undefined;
    }
    return Array.isArray(x) ? x : [x];
}

function normalizeStringMap(input?: StringMap | string[]): StringMap | undefined {
    if (!input) {
        return undefined;
    }
    if (Array.isArray(input)) {
        const out: StringMap = {};
        for (const v of input) {
            const i = v.indexOf('=');
            if (i === -1) {
                out[v] = '';
            } else {
                out[v.slice(0, i)] = v.slice(i + 1);
            }
        }
        return out;
    }
    // force string values
    const out: StringMap = {};
    for (const [k, v] of Object.entries(input)) {
        out[k] = String(v);
    }
    return out;
}

function normalizeEnvironment(env?: ComposeService['environment']): ComposeService['environment'] {
    return normalizeStringMap(env as any);
}

function normalizeDependsOn(dep?: ComposeService['depends_on']): ComposeService['depends_on'] | undefined {
    if (!dep) {
        return undefined;
    }
    if (Array.isArray(dep)) {
        return dep;
    }
    if (isObject(dep)) {
        return dep as any;
    }
    // string (legacy unlikely here, but normalize)
    return [String(dep)];
}

function normalizePorts(ports?: ComposeService['ports']): ComposeService['ports'] | undefined {
    if (!ports) {
        return undefined;
    }
    return ports.map(p => {
        if (typeof p === 'string') {
            return p;
        }
        // ensure shape correctness
        const obj: any = {
            target: Number(p.target),
            published: p.published != null ? Number(p.published) : undefined,
            protocol: p.protocol ?? 'tcp',
            mode: p.mode,
        };
        if (!obj.target || Number.isNaN(obj.target)) {
            throw new Error(`Invalid port target: ${JSON.stringify(p)}`);
        }
        return obj;
    });
}

function normalizeVolumes(vols?: ComposeService['volumes']): ComposeService['volumes'] | undefined {
    if (!vols) {
        return undefined;
    }
    return vols.map(v => {
        if (typeof v === 'string') {
            return v;
        }
        const mv: ComposeVolumeMount = { target: v.target };
        if (v.type) {
            mv.type = v.type;
        }
        if (v.source) {
            mv.source = v.source;
        }
        if (v.read_only != null) {
            mv.read_only = !!v.read_only;
        }
        if (v.consistency) {
            mv.consistency = v.consistency;
        }
        if (v.bind) {
            mv.bind = { ...v.bind };
        }
        if (v.volume) {
            mv.volume = { ...v.volume };
        }
        if (v.tmpfs) {
            mv.tmpfs = { ...v.tmpfs };
        }
        return mv;
    });
}

function normalizeNetworks(n?: ComposeService['networks']): ComposeService['networks'] | undefined {
    if (!n) {
        return undefined;
    }
    if (Array.isArray(n)) {
        return n.map(item => (typeof item === 'string' ? item : { ...item }));
    }
    if (isObject(n)) {
        return { ...n } as any;
    } // StringMap form
    return undefined;
}

function normalizeLabels(labels?: ComposeService['labels']): ComposeService['labels'] | undefined {
    // accept object or ["k=v"]
    if (!labels) {
        return undefined;
    }
    if (Array.isArray(labels)) {
        return labels;
    }
    const normalized = normalizeStringMap(labels);
    return normalized;
}

function normalizeHealthcheck(h?: any): ComposeHealthcheck | undefined {
    if (!h) {
        return undefined;
    }
    if (!('test' in h)) {
        return undefined;
    }
    const test = Array.isArray(h.test) || typeof h.test === 'string' ? h.test : ['NONE'];
    const hc: ComposeHealthcheck = { test };
    if (h.interval != null) {
        hc.interval = String(h.interval) as Duration;
    }
    if (h.timeout != null) {
        hc.timeout = String(h.timeout) as Duration;
    }
    if (h.retries != null) {
        hc.retries = Number(h.retries);
    }
    if (h.start_period != null) {
        hc.start_period = String(h.start_period) as Duration;
    }
    return hc;
}

function normalizeBuild(b?: ComposeBuild | string): ComposeBuild | string | undefined {
    if (!b) {
        return undefined;
    }
    if (typeof b === 'string') {
        return b;
    } // shorthand -> context path
    const out: ComposeBuild = { ...b };
    if (out.args) {
        // ensure args are KV (stringifiable)
        const kv: KV = {};
        for (const [k, v] of Object.entries(out.args)) {
            kv[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
        }
        out.args = kv;
    }
    if (out.labels) {
        out.labels = normalizeStringMap(out.labels as any) ?? {};
    }
    if (out.extra_hosts && Array.isArray(out.extra_hosts)) {
        // keep as list "host:ip" if provided; allowed by compose
        out.extra_hosts = out.extra_hosts.slice();
    }
    return out;
}

export function cleanUndefined(obj: Record<string, any>): Record<string, any> | undefined {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }
    if (Array.isArray(obj)) {
        const res: any[] = [];
        for (let i = 0; i < obj.length; i++) {
            if (obj[i] !== undefined) {
                if (typeof obj[i] === 'object' && obj[i] !== null) {
                    const item = cleanUndefined(obj[i]);
                    if (
                        item !== undefined &&
                        (typeof item !== 'object' ||
                            (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0))
                    ) {
                        res.push(item);
                    }
                } else {
                    res.push(obj[i]);
                }
            }
        }
        if (!res.length) {
            return undefined;
        }
        return res.map(cleanUndefined);
    }
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
        const item = cleanUndefined(v);
        if (item !== undefined) {
            res[k] = item;
        }
    }
    if (Object.keys(res).length === 0) {
        return undefined;
    }

    return res;
}

/* -----------------------------
 * Main converter
 * -----------------------------*/

export default function composeFromYaml(input: string | Record<string, any>): ComposeTop {
    const raw: any = typeof input === 'string' ? yaml.load(input) : input;
    if (!raw || typeof raw !== 'object') {
        throw new Error('Compose: cannot parse input');
    }

    const version = raw.version ?? '3.9';

    const servicesIn = raw.services;
    if (!servicesIn || typeof servicesIn !== 'object') {
        throw new Error('Compose: missing `services`');
    }

    const services: Record<string, ComposeService> = {};

    for (const [name, svcRaw] of Object.entries<any>(servicesIn)) {
        if (!isObject(svcRaw)) {
            throw new Error(`Compose: service ${name} must be an object`);
        }

        const s: ComposeService = {};

        s.container_name = svcRaw.container_name;
        s.image = svcRaw.image;
        s.build = normalizeBuild(svcRaw.build);
        s.command = svcRaw.command;
        s.entrypoint = svcRaw.entrypoint;

        s.user = svcRaw.user;
        s.working_dir = svcRaw.working_dir;
        s.hostname = svcRaw.hostname;
        s.domainname = svcRaw.domainname;

        s.environment = normalizeEnvironment(svcRaw.environment);
        s.env_file = svcRaw.env_file;

        s.labels = normalizeLabels(svcRaw.labels);

        s.ports = normalizePorts(arrify(svcRaw.ports));
        s.expose = arrify(svcRaw.expose);
        s.volumes = normalizeVolumes(arrify(svcRaw.volumes));
        s.devices = arrify(svcRaw.devices);

        if (svcRaw.extra_hosts) {
            s.extra_hosts = Array.isArray(svcRaw.extra_hosts) ? svcRaw.extra_hosts.slice() : { ...svcRaw.extra_hosts };
        }

        s.dns = arrify(svcRaw.dns);
        s.dns_search = arrify(svcRaw.dns_search);
        s.dns_opt = arrify(svcRaw.dns_opt);

        s.networks = normalizeNetworks(svcRaw.networks);

        s.healthcheck = normalizeHealthcheck(svcRaw.healthcheck);

        s.restart = svcRaw.restart;
        s.tty = !!svcRaw.tty;
        s.stdin_open = !!svcRaw.stdin_open;

        // Normalize depends_on: accept array, map, or legacy boolean form
        // If someone used legacy `depends_on: { svc: { condition: service_healthy } }` we keep as-is.
        // If they used `depends_on: [svc1, svc2]`, keep as array.
        s.depends_on = normalizeDependsOn(svcRaw.depends_on);

        if (svcRaw.stop_grace_period != null) {
            s.stop_grace_period = String(svcRaw.stop_grace_period) as Duration;
        }
        if (svcRaw.stop_signal != null) {
            s.stop_signal = String(svcRaw.stop_signal);
        }

        if (svcRaw.logging) {
            const l: ComposeLogging = {};
            if (svcRaw.logging.driver) {
                l.driver = String(svcRaw.logging.driver) as ComposeLogging['driver'];
            }
            if (svcRaw.logging.options) {
                const opt: KV = {};
                for (const [k, v] of Object.entries(svcRaw.logging.options)) {
                    opt[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
                }
                l.options = opt;
            }
            s.logging = l;
        }

        s.security_opt = arrify(svcRaw.security_opt);
        if (svcRaw.privileged != null) {
            s.privileged = !!svcRaw.privileged;
        }
        if (svcRaw.read_only != null) {
            s.read_only = !!svcRaw.read_only;
        }
        if (svcRaw.shm_size != null) {
            s.shm_size = svcRaw.shm_size;
        }
        if (svcRaw.sysctls) {
            s.sysctls = { ...svcRaw.sysctls };
        }

        if (svcRaw.deploy) {
            // Keep deploy mostly as-is; Compose will validate at runtime.
            s.deploy = { ...svcRaw.deploy };
        }

        // Preserve unknown extension fields under x_extra
        for (const [k, v] of Object.entries(svcRaw)) {
            if (k.startsWith('x-')) {
                s.x_extra = s.x_extra || {};
                s.x_extra[k] = v;
            }
        }

        services[name] = s;
    }

    // Top-level networks/volumes/secrets/configs: shallow copy/normalize label maps
    const networks = raw.networks ? { ...raw.networks } : undefined;
    const volumes = raw.volumes ? { ...raw.volumes } : undefined;
    const secrets = raw.secrets ? { ...raw.secrets } : undefined;
    const configs = raw.configs ? { ...raw.configs } : undefined;

    // Preserve top-level x-* extension fields
    const extra: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(raw)) {
        if (k.startsWith('x-')) {
            extra[k] = v;
        }
    }

    const out: ComposeTop = {
        version,
        services,
        networks,
        volumes,
        secrets,
        configs,
        ...extra,
    };

    return cleanUndefined(out) as ComposeTop;
}
