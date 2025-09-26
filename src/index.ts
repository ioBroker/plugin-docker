import { PluginBase } from '@iobroker/plugin-base';
import DockerManagerOfOwnContainers from './lib/DockerManagerOfOwnContainers';
import DockerManager from './lib/DockerManager';
import type {
    ContainerConfig,
    ContainerInfo,
    ImageInfo,
    NetworkDriver,
    NetworkInfo,
    VolumeDriver,
    DockerContainerInspect,
    DockerImageTagsResponse,
    VolumeInfo,
} from './types';
import { readFileSync } from 'node:fs';
import JSON5 from 'json5';
import composeFromYaml, { type ComposeTop } from './lib/parseDockerCompose';
import { composeToContainerConfigs } from './lib/compose2config';
import { walkTheConfig } from './lib/templates';

export type DockerConfig = ComposeTop;

export {
    DockerManagerOfOwnContainers,
    DockerManager,
    type ContainerConfig,
    type ContainerInfo,
    type ImageInfo,
    type NetworkDriver,
    type NetworkInfo,
    type VolumeDriver,
    type VolumeInfo,
    type DockerImageTagsResponse,
    type DockerContainerInspect,
};

export default class DockerPlugin extends PluginBase {
    #dockerManager: DockerManagerOfOwnContainers | null = null;
    #configurations: ContainerConfig[] = [];
    #iobDockerApi:
        | {
              host: string;
              port: number;
              protocol: 'http' | 'https';
              ca?: string;
              cert?: string;
              key?: string;
          }
        | undefined; // ioBroker setting;
    /** Return the Docker configurations that will be managed */
    get configurations(): ContainerConfig[] {
        return this.#configurations;
    }

    /**
     * Register and initialize Docker
     *
     * @param pluginConfig plugin configuration from config files
     */
    async init(pluginConfig: DockerConfig): Promise<void> {
        // Read the instance config
        const instanceObj: ioBroker.InstanceObject | null | undefined = await this.getObject(
            this.settings.parentNamespace,
        );
        if (!instanceObj) {
            throw new Error(`Cannot find instance object ${this.settings.parentNamespace}`);
        }

        walkTheConfig(pluginConfig, instanceObj.native);

        // If dockerFiles is specified, read the files and merge them with dockerConfigs
        if (pluginConfig.iobDockerComposeFiles) {
            for (const filePath of pluginConfig.iobDockerComposeFiles) {
                try {
                    const fileContent = readFileSync(`${this.settings.adapterDir}/${filePath}`, 'utf-8');
                    if (filePath.endsWith('.json')) {
                        try {
                            const fileJson = JSON.parse(fileContent);
                            const pureFileConfig = walkTheConfig(fileJson, instanceObj.native);
                            const config = composeToContainerConfigs(pureFileConfig);
                            this.#configurations.push(...config);
                        } catch (err) {
                            this.log.error(`Cannot parse docker config file ${filePath}: ${err}`);
                        }
                    } else if (filePath.endsWith('.json5')) {
                        try {
                            const fileJson = JSON5.parse(fileContent);
                            const pureFileConfig = walkTheConfig(fileJson, instanceObj.native);
                            const config = composeToContainerConfigs(pureFileConfig);
                            this.#configurations.push(...config);
                        } catch (err) {
                            this.log.error(`Cannot parse docker config file ${filePath}: ${err}`);
                        }
                    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
                        try {
                            const fileYaml = composeFromYaml(fileContent);
                            const pureFileConfig = walkTheConfig(fileYaml, instanceObj.native) as ComposeTop;
                            const config = composeToContainerConfigs(pureFileConfig);
                            this.#configurations.push(...config);
                        } catch (err) {
                            this.log.error(`Cannot parse docker config file ${filePath}: ${err}`);
                        }
                    } else {
                        this.log.warn(`Unknown file extension of docker config file ${filePath}`);
                    }
                } catch (err) {
                    this.log.error(`Cannot read docker config file ${filePath}: ${err}`);
                }
            }
        }

        if (!this.#configurations.length) {
            this.log.info('No Docker containers to manage');
            return;
        }

        // If any container has iobDockerApi, we need to read available docker configurations
        if (pluginConfig.iobDockerApi && typeof pluginConfig.iobDockerApi === 'string') {
            // If iobDockerApi is a string, we need to read the system.docker object
            const systemDockerObj: ioBroker.Object | null | undefined = await this.getObject('system.docker');
            const nativeConfig = systemDockerObj?.native as
                | {
                      hosts: {
                          [name: string]: {
                              host: string;
                              port: number;
                              protocol: 'http' | 'https';
                              ca?: string;
                              cert?: string;
                              key?: string;
                          };
                      };
                  }
                | undefined;
            if (nativeConfig) {
                // Replace all iobDockerApi strings with actual config objects
                // fallback to local socket if no system.docker object
                if (!nativeConfig.hosts[pluginConfig.iobDockerApi]) {
                    this.log.warn(`Cannot find docker configuration for ${pluginConfig.iobDockerApi}`);
                    delete pluginConfig.iobDockerApi;
                } else {
                    pluginConfig.iobDockerApi = nativeConfig.hosts[pluginConfig.iobDockerApi];
                }
            } else {
                this.log.warn(
                    'Cannot find system.docker object, but at least one container requires it. Will use local socket',
                );
                delete pluginConfig.iobDockerApi;
            }
        }

        if (typeof pluginConfig.iobDockerApi === 'object') {
            this.#iobDockerApi = pluginConfig.iobDockerApi;
        }

        if (!this.#configurations.find(conf => conf.iobWaitForReady)) {
            await this.#startDockerManager();
        }
    }

    async #startDockerManager(): Promise<void> {
        if (this.#configurations.find(conf => conf.iobEnabled !== false)) {
            this.#dockerManager ||= new DockerManagerOfOwnContainers(
                {
                    dockerApi: this.#iobDockerApi,
                    logger: {
                        level: 'silly',
                        silly: this.log.silly.bind(this.log),
                        debug: this.log.debug.bind(this.log),
                        info: this.log.info.bind(this.log),
                        warn: this.log.warn.bind(this.log),
                        error: this.log.error.bind(this.log),
                    },
                    namespace: this.parentNamespace as `${string}.${number}`,
                },
                this.#configurations,
            );

            await this.#dockerManager.isReady();
        }
    }

    /**
     * Return the DockerManager object. This can be used to monitor containers
     */
    getDockerManager(): DockerManagerOfOwnContainers | null {
        return this.#dockerManager;
    }

    /**
     * This function will be called when the instance prepared all data to be copied to volume.
     * It should be only called if any container has a flag "iobWaitForReady"
     *
     * @returns Promise which will be resolved when all containers are ready (or immediately if no container has the flag
     */
    async instanceIsReady(): Promise<void> {
        await this.#startDockerManager();
    }
}
