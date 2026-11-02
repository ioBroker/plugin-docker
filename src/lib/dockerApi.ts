import { walkTheConfig } from './templates';

/** A connection to a Docker API, as the `DockerManager` takes it as `dockerApi` */
export interface DockerApiConfig {
    /** host of the Docker API */
    host: string;
    /** port of the Docker API */
    port: number;
    /** protocol of the Docker API */
    protocol: 'http' | 'https';
    /** CA certificate */
    ca?: string;
    /** client certificate */
    cert?: string;
    /** client key */
    key?: string;
}

/**
 * Find the Docker API an instance uses.
 *
 * `iobDockerApi` of the plugin config (`common.plugins.docker` in `io-package.json`) may be
 * - missing: the Docker of the host - the `DockerManager` finds it itself, so the answer is `undefined`
 * - the name of a connection in `native.hosts` of the object `system.docker`
 * - a connection object
 *
 * Templates are resolved with the instance config first, in the name as in the fields of an object - e.g.
 * `"iobDockerApi": "${config.dockerApi}"` lets the user choose the connection in the instance settings.
 *
 * A name that `system.docker` does not define falls back to the Docker of the host, with a warning.
 *
 * Exported so that whoever needs the Docker of an instance finds the same one the plugin uses - e.g. the
 * js-controller, when it answers whether the instance can use Docker, or an adapter that creates a `DockerManager`
 * of its own.
 *
 * @param options what to resolve
 * @param options.iobDockerApi `iobDockerApi` of the plugin config, as written there (templates not yet resolved)
 * @param options.instanceConfig `native` of the instance object
 * @param options.instance number of the instance, for `${instance}`
 * @param options.getSystemDocker reads the object `system.docker` - called only if a connection is named
 * @param options.log receives the warning if the connection cannot be found
 * @returns the connection, or undefined for the Docker of the host
 */
export async function resolveDockerApi(options: {
    iobDockerApi: unknown;
    instanceConfig: Record<string, any>;
    instance: number;
    getSystemDocker: () => Promise<ioBroker.Object | null | undefined>;
    log?: Pick<ioBroker.Logger, 'warn'>;
}): Promise<DockerApiConfig | undefined> {
    const iobDockerApi = walkTheConfig(options.iobDockerApi, options.instanceConfig as ioBroker.AdapterConfig, {
        instance: options.instance,
    });
    if (iobDockerApi && typeof iobDockerApi === 'object' && !Array.isArray(iobDockerApi)) {
        return iobDockerApi as DockerApiConfig;
    }
    if (!iobDockerApi || typeof iobDockerApi !== 'string') {
        return undefined;
    }

    const systemDocker = await options.getSystemDocker();
    if (!systemDocker?.native) {
        options.log?.warn(
            'Cannot find system.docker object, but at least one container requires it. Will use local socket',
        );
        return undefined;
    }
    const hosts = (systemDocker.native as { hosts?: Record<string, DockerApiConfig | undefined> }).hosts;
    // only own entries: a name like "__proto__" is no connection
    const dockerApi =
        hosts && Object.prototype.hasOwnProperty.call(hosts, iobDockerApi) ? hosts[iobDockerApi] : undefined;
    if (!dockerApi || typeof dockerApi !== 'object') {
        options.log?.warn(`Cannot find docker configuration for ${iobDockerApi}`);
        return undefined;
    }
    return dockerApi;
}
