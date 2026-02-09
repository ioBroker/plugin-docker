// This class implements docker commands using CLI, and
// it monitors periodically the docker daemon status.
// It manages containers defined in common.plugins.docker and could monitor other containers

import { join } from 'path';
import type { ContainerConfig, ContainerStats, ContainerStatus, DockerContainerInspect } from '../types';
import DockerManager from './DockerManager';

const dockerDefaults: Record<string, any> = {
    tty: false,
    stdinOpen: false,
    attachStdin: false,
    attachStdout: false,
    attachStderr: false,
    openStdin: false,
    publishAllPorts: false,
    readOnly: false,
    user: '',
    workdir: '',
    domainname: '',
    macAddress: '',
    networkMode: 'bridge',
};

function isDefault(value: any, def: any): boolean {
    return JSON.stringify(value) === JSON.stringify(def);
}

function deepCompare(object1: any, object2: any): boolean {
    if (typeof object1 === 'number') {
        object1 = object1.toString();
    }
    if (typeof object2 === 'number') {
        object2 = object2.toString();
    }
    if (typeof object1 !== typeof object2) {
        return false;
    }
    if (typeof object1 !== 'object' || object1 === null || object2 === null) {
        return object1 === object2;
    }
    if (Array.isArray(object1)) {
        if (!Array.isArray(object2) || object1.length !== object2.length) {
            return false;
        }
        for (let i = 0; i < object1.length; i++) {
            if (!deepCompare(object1[i], object2[i])) {
                return false;
            }
        }
        return true;
    }
    const keys1 = Object.keys(object1);
    for (const key of keys1) {
        // ignore iob* properties as they belong to ioBroker configuration
        // ignore hostname and dependsOn as it is only for docker-compose
        if (key.startsWith('iob') || key === 'hostname' || key === 'dependsOn' || key === 'devices') {
            continue;
        }
        if (!deepCompare(object1[key], object2[key])) {
            return false;
        }
    }
    return true;
}

function compareConfigs(_desired: ContainerConfig, _existing: ContainerConfig): string[] {
    const diffs: string[] = [];
    const desired: ContainerConfig = JSON.parse(JSON.stringify(_desired));
    const existing: ContainerConfig = JSON.parse(JSON.stringify(_existing));

    const keys: (keyof ContainerConfig)[] = Object.keys(desired) as Array<keyof ContainerConfig>;

    // Order mounts, volumes and ports to avoid diffs if only the order is different
    if (desired.mounts) {
        desired.mounts = desired.mounts.map(m => ({ ...m })).sort((a, b) => a.target.localeCompare(b.target));

        // readonly flag will be ignored, because it is not possible to change it without recreating the container, so it would always cause a diff
        desired.mounts.forEach(m => delete m.readOnly);
    }
    if (existing.mounts) {
        existing.mounts = existing.mounts.map(m => ({ ...m })).sort((a, b) => a.target.localeCompare(b.target));
        existing.mounts.forEach(m => delete m.readOnly);
        // "source": "iob_frigate_0_frigate_logs", => "source": "/var/lib/docker/volumes/iob_frigate_0_frigate_logs/_data",
        existing.mounts.forEach(m => {
            if (typeof m.source === 'string' && m.source?.includes('/volumes/') && m.source.includes('/_data')) {
                const parts = m.source.split('/');
                m.source = parts[parts.length - 2];
            }
        });
    }
    if (desired.volumes) {
        desired.volumes = desired.volumes
            .map(v => v.trim())
            .filter(v => v)
            .sort();
    }
    if (existing.volumes) {
        existing.volumes = existing.volumes
            .map(v => v.trim())
            .filter(v => v)
            .sort();
    }
    if (desired.ports) {
        desired.ports = desired.ports
            .map(p => ({ ...p }))
            .sort((a, b) => {
                if (a.hostPort !== b.hostPort) {
                    return parseInt(a.containerPort as string, 10) - parseInt(b.containerPort as string, 10);
                }
                if (a.hostIP !== b.hostIP && a.hostIP && b.hostIP) {
                    return a.hostIP?.localeCompare(b.hostIP);
                }
                return 0;
            });
    }
    if (existing.ports) {
        existing.ports = existing.ports
            .map(p => ({ ...p }))
            .sort((a, b) => {
                if (a.hostPort !== b.hostPort) {
                    return parseInt(a.containerPort as string, 10) - parseInt(b.containerPort as string, 10);
                }
                if (a.hostIP !== b.hostIP && a.hostIP && b.hostIP) {
                    return a.hostIP?.localeCompare(b.hostIP);
                }
                return 0;
            });
    }

    // We only compare keys that are in the desired config
    for (const key of keys) {
        // ignore iob* properties as they belong to ioBroker configuration
        // ignore hostname and dependsOn as it is only for docker-compose
        if (key.startsWith('iob') || key === 'hostname' || key === 'dependsOn' || key === 'devices') {
            continue;
        }
        if (typeof desired[key] === 'object' && desired[key] !== null) {
            if (Array.isArray(desired[key])) {
                if (!Array.isArray(existing[key]) || desired[key].length !== existing[key].length) {
                    diffs.push(key);
                } else {
                    for (let i = 0; i < desired[key].length; i++) {
                        if (!deepCompare(desired[key][i], existing[key][i])) {
                            diffs.push(`${key}[${i}]`);
                        }
                    }
                }
            } else {
                Object.keys(desired[key]).forEach((subKey: string) => {
                    if (!deepCompare((desired as any)[key][subKey], (existing as any)[key][subKey])) {
                        diffs.push(`${key}.${subKey}`);
                    }
                });
            }
        } else if (desired[key] !== existing[key]) {
            diffs.push(key);
        }
    }

    return diffs;
}

// remove undefined entries recursively
function removeUndefined(obj: any): any {
    if (Array.isArray(obj)) {
        const arr = obj.map(v => (v && typeof v === 'object' ? removeUndefined(v) : v)).filter(v => v !== undefined);
        if (!arr.length) {
            return undefined;
        }
        return arr;
    }
    if (obj && typeof obj === 'object') {
        const _obj = Object.fromEntries(
            Object.entries(obj)
                .map(([k, v]) => [k, v && typeof v === 'object' ? removeUndefined(v) : v])
                .filter(
                    ([_, v]) =>
                        v !== undefined &&
                        v !== null &&
                        v !== '' &&
                        !(Array.isArray(v) && v.length === 0) &&
                        !(typeof v === 'object' && Object.keys(v).length === 0),
                ),
        );
        if (Object.keys(_obj).length === 0) {
            return undefined;
        }
        return _obj;
    }
    if (obj === '') {
        return undefined;
    }
    return obj;
}

function cleanContainerConfig(obj: ContainerConfig, mayChange?: boolean): ContainerConfig {
    obj = removeUndefined(obj);

    Object.keys(obj).forEach(name => {
        if (isDefault((obj as any)[name], (dockerDefaults as any)[name])) {
            delete (obj as any)[name];
        }
        if (name === 'mounts') {
            if (!obj.mounts) {
                delete obj.mounts;
                return;
            }
            obj.mounts = obj.mounts.map((mount: any) => {
                const m = { ...mount };
                // /var/lib/docker/volumes/influxdb_0_flux_config/_data
                if (mayChange && m.source.includes('/docker/volumes') && m.source.endsWith('/_data')) {
                    const parts = m.source.split('/');
                    m.source = parts[parts.length - 2];
                }
                delete m.readOnly;
                return m;
            });
            if (!obj.mounts.length) {
                delete obj.mounts;
                return;
            }
            obj.mounts?.sort((a, b) => a.target.localeCompare(b.target));
        }
        if (name === 'ports') {
            if (!obj.ports) {
                delete obj.ports;
                return;
            }
            obj.ports = obj.ports.map((port: any) => {
                const p = { ...port };
                if (p.protocol === 'tcp') {
                    delete p.protocol;
                }
                return p;
            });
            if (!obj.ports.length) {
                delete obj.ports;
                return;
            }
            obj.ports?.sort((a, b) => {
                if (a.hostPort !== b.hostPort) {
                    return parseInt(a.containerPort as string, 10) - parseInt(b.containerPort as string, 10);
                }
                if (a.hostIP !== b.hostIP && a.hostIP && b.hostIP) {
                    return a.hostIP?.localeCompare(b.hostIP);
                }
                return 0;
            });
        }
        if (name === 'environment') {
            if (!obj.environment) {
                delete obj.environment;
                return;
            }
            const env = obj.environment as { [key: string]: string };
            if (Object.keys(env).length) {
                obj.environment = {};
                Object.keys(env)
                    .sort()
                    .forEach(key => {
                        if (key && env[key] && obj.environment) {
                            obj.environment[key] = env[key];
                        }
                    });
            } else {
                delete obj.environment;
            }
            if (!Object.keys(env).length) {
                delete obj.environment;
            }
        }
        if (name === 'labels') {
            if (!obj.labels) {
                delete obj.labels;
                return;
            }
            const labels = obj.labels as { [key: string]: string };
            if (Object.keys(labels).length) {
                obj.labels = {};
                Object.keys(labels)
                    .sort()
                    .forEach(key => {
                        if (key && labels[key] && obj.labels) {
                            obj.labels[key] = labels[key];
                        }
                    });
            } else {
                delete obj.labels;
            }
            if (!Object.keys(labels).length) {
                delete obj.labels;
            }
        }
        if (name === 'volumes') {
            if (!obj.volumes?.length) {
                delete obj.volumes;
                return;
            }
            obj.volumes = obj.volumes.map(v => v.trim()).filter(v => v);
            obj.volumes.sort();
            if (!obj.volumes?.length) {
                delete obj.volumes;
            }
        }
        if (name === 'command') {
            if (!obj.command) {
                delete obj.command;
                return;
            }
            // Make from command array with one string a string, because in this case both forms are possible
            if (Array.isArray(obj.command) && obj.command.length === 1 && typeof obj.command[0] === 'string') {
                obj.command = obj.command[0];
            }
        }
    });

    obj.volumes?.sort();
    return obj;
}

export default class DockerManagerOfOwnContainers extends DockerManager {
    readonly #waitAllChecked: Promise<void>;
    #waitAllCheckedResolve: (() => void) | undefined;
    readonly #ownContainers: ContainerConfig[] = [];
    #monitoringInterval: NodeJS.Timeout | null = null;
    #ownContainersStats: { [name: string]: ContainerStatus } = {};
    #adapterDir: string;

    constructor(
        options: {
            dockerApi?: {
                host?: string;
                port?: number | string;
                protocol?: 'http' | 'https';
                ca?: string;
                cert?: string;
                key?: string;
            };
            adapterDir?: string;
            logger: ioBroker.Logger;
            namespace: `${string}.${number}`;
        },
        containers?: ContainerConfig[],
    ) {
        super(options);
        this.#adapterDir = options.adapterDir || '';
        this.#ownContainers = containers || [];
        this.#waitAllChecked = new Promise<void>(resolve => (this.#waitAllCheckedResolve = resolve));
    }

    /**
     * Convert information from inspect to docker configuration to start it
     *
     * @param inspect Inspect information
     */
    static mapInspectToConfig(inspect: DockerContainerInspect): ContainerConfig {
        const obj: ContainerConfig = {
            image: inspect.Config.Image,
            name: inspect.Name.replace(/^\//, ''),
            command: inspect.Config.Cmd ?? undefined,
            entrypoint: inspect.Config.Entrypoint ?? undefined,
            user: inspect.Config.User ?? undefined,
            workdir: inspect.Config.WorkingDir ?? undefined,
            hostname: inspect.Config.Hostname ?? undefined,
            domainname: inspect.Config.Domainname ?? undefined,
            macAddress: inspect.NetworkSettings.MacAddress ?? undefined,
            environment: inspect.Config.Env
                ? Object.fromEntries(
                      inspect.Config.Env.map(e => {
                          const [key, ...rest] = e.split('=');
                          return [key, rest.join('=')];
                      }),
                  )
                : undefined,
            labels: inspect.Config.Labels ?? undefined,
            tty: inspect.Config.Tty,
            stdinOpen: inspect.Config.OpenStdin,
            attachStdin: inspect.Config.AttachStdin,
            attachStdout: inspect.Config.AttachStdout,
            attachStderr: inspect.Config.AttachStderr,
            openStdin: inspect.Config.OpenStdin,
            publishAllPorts: inspect.HostConfig.PublishAllPorts,
            ports: inspect.HostConfig.PortBindings
                ? Object.entries(inspect.HostConfig.PortBindings).flatMap(([containerPort, bindings]) =>
                      bindings.map(binding => ({
                          containerPort: containerPort.split('/')[0],
                          protocol: (containerPort.split('/')[1] as 'tcp' | 'udp') || 'tcp',
                          hostPort: binding.HostPort,
                          hostIP: binding.HostIp,
                      })),
                  )
                : undefined,
            mounts: inspect.Mounts?.map(mount => ({
                type: mount.Type,
                source: mount.Source,
                target: mount.Destination,
                readOnly: mount.RW,
            })),
            volumes: inspect.Config.Volumes ? Object.keys(inspect.Config.Volumes) : inspect.HostConfig.Binds,
            extraHosts: inspect.HostConfig.ExtraHosts ?? undefined,
            dns: {
                servers: inspect.HostConfig.Dns,
                search: inspect.HostConfig.DnsSearch,
                options: inspect.HostConfig.DnsOptions,
            },
            networkMode: inspect.HostConfig.NetworkMode,
            networks: inspect.NetworkSettings.Networks
                ? Object.entries(inspect.NetworkSettings.Networks).map(([name, net]) => ({
                      name,
                      aliases: net.Aliases ?? undefined,
                      ipv4Address: net.IPAddress,
                      ipv6Address: net.GlobalIPv6Address,
                      driverOpts: net.DriverOpts ?? undefined,
                  }))
                : undefined,
            restart: {
                policy: inspect.HostConfig.RestartPolicy.Name as any,
                maxRetries: inspect.HostConfig.RestartPolicy.MaximumRetryCount,
            },
            resources: {
                cpuShares: inspect.HostConfig.CpuShares,
                cpuQuota: inspect.HostConfig.CpuQuota,
                cpuPeriod: inspect.HostConfig.CpuPeriod,
                cpusetCpus: inspect.HostConfig.CpusetCpus,
                memory: inspect.HostConfig.Memory,
                memorySwap: inspect.HostConfig.MemorySwap,
                memoryReservation: inspect.HostConfig.MemoryReservation,
                pidsLimit: inspect.HostConfig.PidsLimit ?? undefined,
                shmSize: inspect.HostConfig.ShmSize,
                readOnlyRootFilesystem: inspect.HostConfig.ReadonlyRootfs,
            },
            logging: {
                driver: inspect.HostConfig.LogConfig.Type,
                options: inspect.HostConfig.LogConfig.Config,
            },
            security: {
                privileged: inspect.HostConfig.Privileged,
                capAdd: inspect.HostConfig.CapAdd ?? undefined,
                capDrop: inspect.HostConfig.CapDrop ?? undefined,
                usernsMode: inspect.HostConfig.UsernsMode ?? undefined,
                ipc: inspect.HostConfig.IpcMode,
                pid: inspect.HostConfig.PidMode,
                seccomp:
                    inspect.HostConfig.SecurityOpt?.find(opt => opt.startsWith('seccomp='))?.split('=')[1] ?? undefined,
                apparmor:
                    inspect.HostConfig.SecurityOpt?.find(opt => opt.startsWith('apparmor='))?.split('=')[1] ??
                    undefined,
                groupAdd: inspect.HostConfig.GroupAdd ?? undefined,
                noNewPrivileges: undefined, // Nicht direkt verfügbar
            },
            sysctls: inspect.HostConfig.Sysctls ?? undefined,
            init: inspect.HostConfig.Init ?? undefined,
            stop: {
                signal: inspect.Config.StopSignal ?? undefined,
                gracePeriodSec: inspect.Config.StopTimeout ?? undefined,
            },
            readOnly: inspect.HostConfig.ReadonlyRootfs,
            timezone: undefined, // Nicht direkt verfügbar
            __meta: undefined, // Eigene Metadaten
        };

        return cleanContainerConfig(obj, true);
    }

    async init(): Promise<void> {
        await super.init();
        if (this.installed) {
            await this.#checkOwnContainers();
        } else {
            this.#waitAllCheckedResolve?.();
        }
    }

    /**
     * Ensure that the given container is running with the actual configuration
     *
     * @param container Container configuration
     */
    async #ensureActualConfiguration(container: ContainerConfig): Promise<void> {
        if (!container.name) {
            throw new Error(`Container name must be a string, but got boolean true`);
        }
        // Check the configuration of the container
        const inspect = await this.containerInspect(container.name);
        if (inspect) {
            const existingConfig = DockerManagerOfOwnContainers.mapInspectToConfig(inspect);
            console.log('Compare existing config', existingConfig, ' and', container);
            container = cleanContainerConfig(container);
            const diffs = compareConfigs(container, existingConfig);
            if (diffs.length) {
                this.log.info(
                    `Configuration of own container ${container.name} has changed: ${diffs.join(
                        ', ',
                    )}. Restarting container...`,
                );
                const result = await this.containerReCreate(container);
                if (result.stderr) {
                    this.log.warn(`Cannot recreate own container ${container.name}: ${result.stderr}`);
                }
            } else {
                this.log.debug(`Configuration of own container ${container.name} is up to date`);
            }

            // Check if container is running
            const status = await this.containerList(true);
            const containerInfo = status.find(it => it.names === container.name);
            if (containerInfo) {
                if (containerInfo.status !== 'running' && containerInfo.status !== 'restarting') {
                    // Start the container
                    this.log.info(`Starting own container ${container.name}`);
                    try {
                        const result = await this.containerStart(containerInfo.id);
                        if (result.stderr) {
                            this.log.warn(`Cannot start own container ${container.name}: ${result.stderr}`);
                        }
                    } catch (e) {
                        this.log.warn(`Cannot start own container ${container.name}: ${e.message}`);
                    }
                } else {
                    this.log.debug(`Own container ${container.name} is already running`);
                }
            } else {
                this.log.warn(`Own container ${container.name} not found in container list after recreation`);
            }
        }
    }

    getDefaultContainerName(): string {
        return `iob_${this.namespace.replace(/[-.]/g, '_')}`;
    }

    #modifyContainerName(containerName?: string | boolean): string {
        const prefix = this.getDefaultContainerName();
        if (containerName === true || containerName === 'true' || !containerName) {
            return prefix;
        }
        if (typeof containerName === 'string') {
            // Name of the container, name of the network and name of the volume must start with iob_<Adaptername>_<instance>_
            if (containerName !== prefix && !containerName.startsWith(`${prefix}_`)) {
                this.log.debug(`Renaming container ${containerName} to be prefixed with iob_${prefix}_`);
                return `${prefix}_${containerName}`;
            }
            return containerName;
        }
        throw new Error(`Container name must be a string, but got boolean ${containerName as any}`);
    }

    async #checkOwnContainers(): Promise<void> {
        if (!this.#ownContainers.length) {
            this.#waitAllCheckedResolve?.();
            return;
        }
        const status = await this.containerList(true);
        let images = await this.imageList();
        let anyStartedOrRunning = false;
        const networkChecked: string[] = [];
        const prefix = this.getDefaultContainerName();
        for (let c = 0; c < this.#ownContainers.length; c++) {
            const container = this.#ownContainers[c];
            if (container.iobEnabled !== false) {
                if (!container.image.includes(':')) {
                    container.image += ':latest';
                }
                if (container.labels?.iobroker !== this.namespace) {
                    container.labels = { ...container.labels, iobroker: this.namespace };
                }
                container.name = this.#modifyContainerName(container.name);

                try {
                    // create iobroker network if necessary
                    if (
                        container.networkMode &&
                        container.networkMode !== 'container' &&
                        container.networkMode !== 'host' &&
                        container.networkMode !== 'bridge' &&
                        container.networkMode !== 'none'
                    ) {
                        if (container.networkMode === true || container.networkMode === 'true') {
                            container.networkMode = prefix;
                        }
                        if (
                            container.networkMode !== 'iobroker' &&
                            container.networkMode !== prefix &&
                            !container.networkMode.startsWith(`${prefix}_`)
                        ) {
                            this.log.debug(`Renaming network ${container.networkMode} to be prefixed with ${prefix}_`);
                            container.networkMode = `${prefix}_${container.networkMode}`;
                        }

                        if (!networkChecked.includes(container.networkMode)) {
                            // check if the network exists
                            const networks = await this.networkList();
                            if (!networks.find(it => it.name === container.networkMode)) {
                                this.log.info(`Creating docker network ${container.networkMode}`);
                                await this.networkCreate(container.networkMode);
                            }

                            networkChecked.push(container.networkMode);
                        }
                    }

                    // create all volumes ourselves, to have a static name
                    if (container.mounts?.find(m => m.type === 'volume')) {
                        // check if the volume exists
                        const volumes = await this.volumeList();
                        for (const mount of container.mounts) {
                            if (mount.type === 'volume' && mount.source) {
                                if (mount.source === true || mount.source === 'true') {
                                    mount.source = prefix;
                                }

                                if (mount.source !== prefix && !mount.source.startsWith(`${prefix}_`)) {
                                    this.log.debug(`Renaming volume ${mount.source} to be prefixed with ${prefix}_`);
                                    mount.source = `${prefix}_${mount.source}`;
                                }
                                if (mount.iobBackup) {
                                    if (!container.labels.iob_backup) {
                                        container.labels = { ...container.labels, iob_backup: mount.source };
                                    } else {
                                        const volumes: string[] = container.labels.iob_backup
                                            .split(',')
                                            .map(v => v.trim())
                                            .filter(v => v);
                                        if (!volumes.includes(mount.source)) {
                                            volumes.push(mount.source);
                                            container.labels = { ...container.labels, iob_backup: volumes.join(',') };
                                        }
                                    }
                                }

                                if (
                                    mount.iobAutoCopyFrom &&
                                    (!mount.iobAutoCopyFrom.startsWith('/') ||
                                        mount.iobAutoCopyFrom.match(/^[a-zA-Z]:/))
                                ) {
                                    mount.iobAutoCopyFrom = join(this.#adapterDir, mount.iobAutoCopyFrom);
                                }

                                const volume = volumes.find(v => v.name === mount.source);
                                if (!volume) {
                                    this.log.info(`Creating docker volume ${mount.source}`);
                                    const result = await this.volumeCreate(mount.source);
                                    if (result.stderr) {
                                        this.log.warn(`Cannot create volume ${mount.source}: ${result.stderr}`);
                                        continue;
                                    }
                                    // Copy data from host to volume
                                    if (mount.iobAutoCopyFrom) {
                                        await this.volumeCopyTo(mount.source, mount.iobAutoCopyFrom);
                                    }
                                } else if (mount.iobAutoCopyFromForce && mount.iobAutoCopyFrom) {
                                    // Copy data from host to volume
                                    await this.volumeCopyTo(mount.source, mount.iobAutoCopyFrom);
                                }
                            }
                        }
                    }

                    let containerInfo = status.find(it => it.names === container.name);
                    let image = images.find(it => `${it.repository}:${it.tag}` === container.image);
                    if (container.iobAutoImageUpdate) {
                        // ensure that the image is actual
                        const newImage = await this.imageUpdate(container.image, true);
                        if (newImage) {
                            this.log.info(`Image ${container.image} for own container ${container.name} was updated`);
                            if (containerInfo) {
                                // destroy current container
                                await this.containerRemove(containerInfo.id);
                                containerInfo = undefined;
                            }
                            image = newImage;
                        }
                    }
                    if (!image) {
                        this.log.info(`Pulling image ${container.image} for own container ${container.name}`);
                        try {
                            const result = await this.imagePull(container.image);
                            if (result.stderr) {
                                this.log.warn(`Cannot pull image ${container.image}: ${result.stderr}`);
                                continue;
                            }
                        } catch (e) {
                            this.log.warn(`Cannot pull image ${container.image}: ${e.message}`);
                            continue;
                        }
                        // Check that image is available now
                        images = await this.imageList();
                        image = images.find(it => `${it.repository}:${it.tag}` === container.image);
                        if (!image) {
                            this.log.warn(
                                `Image ${container.image} for own container ${container.name} not found after pull`,
                            );
                            continue;
                        }
                    }

                    if (containerInfo) {
                        await this.#ensureActualConfiguration(container);
                        anyStartedOrRunning ||= !!container.iobMonitoringEnabled;
                    } else {
                        // Create and start the container, as the container was not found
                        this.log.info(`Creating and starting own container ${container.name}`);

                        try {
                            const result = await this.containerRun(container);
                            if (result.stderr) {
                                this.log.warn(`Cannot start own container ${container.name}: ${result.stderr}`);
                            } else {
                                anyStartedOrRunning ||= !!container.iobMonitoringEnabled;
                            }
                        } catch (e) {
                            this.log.warn(`Cannot start own container ${container.name}: ${e.message}`);
                        }
                    }
                } catch (e) {
                    this.log.warn(`Cannot check own container ${container.name}: ${e.message}`);
                }
            }
        }

        if (anyStartedOrRunning) {
            this.#monitoringInterval ||= setInterval(() => this.#ownContainersMonitor(), 60000);
        }
        this.#waitAllCheckedResolve?.();
    }

    /** Modify configuration of own container by name */
    async ownContainerModify(containerName: string | undefined, changes: Partial<ContainerConfig>): Promise<void> {
        containerName = this.#modifyContainerName(containerName);
        const index = this.#ownContainers.findIndex(c => c.name === containerName);
        if (index === -1) {
            throw new Error(`Own container with name ${containerName} does not exist`);
        }
        const oldContainer = this.#ownContainers[index];
        // todo may be use here deep merge?
        const newContainer = { ...oldContainer, ...changes };
        if (changes.name && changes.name !== oldContainer.name) {
            newContainer.name = this.#modifyContainerName(changes.name);
            if (this.#ownContainers.find(c => c.name === newContainer.name && c.name !== oldContainer.name)) {
                throw new Error(`Own container with name "${newContainer.name}" already exists`);
            }
        }
        this.#ownContainers[index] = cleanContainerConfig(newContainer);
        // start monitoring if necessary
        if (newContainer.iobMonitoringEnabled && !this.#monitoringInterval) {
            this.#monitoringInterval = setInterval(() => this.#ownContainersMonitor(), 60000);
        }
        // check the container
        await this.#checkOwnContainers();
    }

    /** Add new own container */
    async ownContainerAdd(container: ContainerConfig): Promise<void> {
        container.name = this.#modifyContainerName(container.name);
        if (container.iobEnabled === false) {
            // do not add disabled containers
            return;
        }
        if (this.#ownContainers.find(c => c.name === container.name)) {
            throw new Error(`Own container with name "${container.name}" already exists`);
        }
        this.#ownContainers.push(container);
        // start monitoring if necessary
        if (container.iobMonitoringEnabled && !this.#monitoringInterval) {
            this.#monitoringInterval = setInterval(() => this.#ownContainersMonitor(), 60000);
        }
        // check the container
        await this.#checkOwnContainers();
    }

    /** Remove own container by name */
    async ownContainerRemove(containerName?: string): Promise<void> {
        containerName = this.#modifyContainerName(containerName);
        const index = this.#ownContainers.findIndex(c => c.name === containerName);
        if (index === -1) {
            throw new Error(`Own container with name ${containerName} does not exist`);
        }
        this.#ownContainers.splice(index, 1);
        delete this.#ownContainersStats[containerName];
        // if no own containers with monitoring enabled, stop monitoring
        if (!this.#ownContainers.find(c => c.iobMonitoringEnabled) && this.#monitoringInterval) {
            clearInterval(this.#monitoringInterval);
            this.#monitoringInterval = null;
        }
        await this.containerRemove(containerName);
        // Try to remove network and volumes
        const prefix = this.getDefaultContainerName();
        try {
            const networks = await this.networkList();
            if (networks.find(n => n.name === containerName && n.name.startsWith(`${prefix}_`))) {
                await this.networkRemove(containerName);
            }
        } catch {
            // ignore, as maybe it used by someone else
        }
        try {
            const volumes = await this.volumeList();
            if (volumes.find(v => v.name === containerName && v.name.startsWith(`${prefix}_`))) {
                await this.volumeRemove(containerName);
            }
        } catch {
            // ignore, as maybe it used by someone else
        }
    }

    /** Wait till all own containers are checked */
    ownContainerCheckedAll(): Promise<void> {
        return this.#waitAllChecked;
    }

    async #ownContainersMonitor(): Promise<void> {
        // get the status of containers
        const containers = await this.containerList();
        // Check the status of own containers
        for (let c = 0; c < this.#ownContainers.length; c++) {
            const container = this.#ownContainers[c];
            if (container.iobEnabled !== false && container.iobMonitoringEnabled && container.name) {
                // Check if container is running
                const running = containers.find(it => it.names === container.name);
                if (!running || (running.status !== 'running' && running.status !== 'restarting')) {
                    this.log.warn(`Own container ${container.name} is not running. Restarting...`);
                    try {
                        const result = await this.containerStart(container.name);
                        if (result.stderr) {
                            this.log.warn(`Cannot start own container ${container.name}: ${result.stderr}`);
                            this.#ownContainersStats[container.name] = {
                                ...this.#ownContainersStats[container.name],
                                status: running?.status || 'unknown',
                                statusTs: Date.now(),
                            };
                            continue;
                        }
                    } catch (e) {
                        this.log.warn(`Cannot start own container ${container.name}: ${e.message}`);
                        this.#ownContainersStats[container.name] = {
                            ...this.#ownContainersStats[container.name],
                            status: running?.status || 'unknown',
                            statusTs: Date.now(),
                        };
                        continue;
                    }
                }

                // check the stats
                this.#ownContainersStats[container.name] = {
                    ...((await this.containerGetRamAndCpuUsage(container.name)) || ({} as ContainerStats)),
                    status: running?.status || 'unknown',
                    statusTs: Date.now(),
                };
            }
        }
    }

    /** Read own container stats */
    getOwnContainerStats(): { [name: string]: ContainerStatus } {
        return this.#ownContainersStats;
    }

    /** Stop own containers if necessary */
    async destroy(): Promise<void> {
        await super.destroy();
        if (this.#monitoringInterval) {
            clearInterval(this.#monitoringInterval);
            this.#monitoringInterval = null;
        }

        for (const container of this.#ownContainers) {
            if (container.iobEnabled !== false && container.iobStopOnUnload && container.name) {
                this.log.info(`Stopping own container ${container.name} on destroy`);
                try {
                    await this.containerStop(container.name);
                } catch (e) {
                    this.log.warn(`Cannot stop own container ${container.name} on destroy: ${e.message}`);
                }
            }
        }
    }
}
