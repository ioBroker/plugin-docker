# Plugin Docker
Facilitates the integration of the Docker containers.

## Purpose
This plugin allows you to start Docker containers directly from ioBroker.
It provides an interface to start and monitor your Docker containers,
making it easier to integrate containerized applications into your ioBroker setup. It will update and re-create the containers if the configuration changes.

### Prerequisites
- Node.js 20+
- Docker Engine 20.10+

## Plugin configuration
The minimal configuration required for inclusion in the common section of `io-package.json` is as follows:

```json
"plugins": {
    "docker": {
        "iobDockerApi": "default",
        "iobDockerComposeFiles": ["docker-compose.yaml"]
    }
}
```

- `iobDockerApi` is optional and specifies which Docker API to use. It will take the configuration defined in `system.docker` => `native` object. You can use patterns for the name too, e.g. `${config.dockerApiName}` to use the configuration to define the API.

### Docker compose file
The paths in `iobDockerComposeFiles` is relative to the ioBroker Adapter directory.

Here you can see an example of a `docker-compose.yaml` file:

```yaml
version: '3.9'

services:
    influx:
        # If not `container_name` is given, the default name will be used `iob_<adapterName>_<instance>`
        image: influxdb:2
        labels:
            # To avoid the validation error, we must define ioBroker config values as labels see below for details
            - 'iobEnabled=${config.dockerInflux.enabled:-true}'
            - 'iobStopOnUnload=${config.dockerInflux.stopIfInstanceStopped:-true}'
            - 'iobBackup=flux_data'
        container_name: influx
        ports:
            - '${config.dockerInflux.bind:-127.0.0.1}:${config_dockerInflux_port:-8086}:8086'
        environment:
            DOCKER_INFLUXDB_INIT_MODE: 'setup'
            DOCKER_INFLUXDB_INIT_USERNAME: 'iobroker'
            DOCKER_INFLUXDB_INIT_PASSWORD: 'iobroker'
            DOCKER_INFLUXDB_INIT_BUCKET: 'iobroker'
            DOCKER_INFLUXDB_INIT_ORG: 'iobroker'
            DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: 'aW9icm9rZXI4NjY0NTYzODU0NjU2NTY1MjY1Ng=='
        volumes:
            - flux_data:/var/lib/influxdb2
            - flux_config:/etc/influxdb2
        # You can use a special ioBroker network that is the same for all containers started by ioBroker
        networks:
            - true
        restart: unless-stopped

    grafana:
        image: grafana/grafana-oss
        labels:
            - 'iobEnabled=${config.dockerInflux.enabled:-true}'
            - 'iobStopOnUnload=${config.dockerInflux.stopIfInstanceStopped:-true}'
            # Instruction for ioBroker to copy the files from <ADAPTER-DIR>/grafana-provisioning to managed by docker grafana_provisioning volume
            - 'iobCopyVolumes=./grafana-provisioning=>grafana_provisioning'
            # Give the time for adapter to prepare the provisioning files
            - 'iobWaitForReady=true'
        # To every name, the prefix `iob_<adapterName>_<instance>_` will be added
        container_name: grafana
        depends_on:
            - influx
        ports:
          # You can configure container with values from instance config.
          # As validator makes an error if we use `config.dockerGrafana.port` directly,
          # we need to use an alternative name `config_dockerGrafana_port`
          - '${config.dockerGrafana.bind:-127.0.0.1}:${config_dockerGrafana_port:-3000}:3000'
        environment:
          # You can configure container with values from instance config.
            GF_SECURITY_ADMIN_PASSWORD: '${config.dockerGrafana.adminSecurityPassword:-iobroker}'
            GF_SERVER_ROOT_URL: '${config.dockerGrafana.serverRootUrl:-}'
            GF_INSTALL_PLUGINS: '${config.dockerGrafana.plugins:-}'
            GF_USERS_ALLOW_SIGN_UP: '${config.dockerGrafana.usersAllowSignUp:-false}'
        volumes:
            - grafana_data:/var/lib/grafana
            # bind mount so your generated provisioning files are visible
            - grafana_provisioning:/etc/grafana/provisioning
        networks:
          # "true" means the default name will be used `iob_<adapterName>_<instance>`. If it is not true and not standrat name, the prefix `iob_<adapterName>_<instance>_` will be added
            - true
        restart: unless-stopped

networks:
    # "true" means the default name will be used `iob_<adapterName>_<instance>`
    true:
        driver: bridge

volumes:
    flux_data:
    flux_config:
    grafana_data:
    grafana_provisioning:
```

#### ioBroker specific labels
To allow the Docker plugin to manage your containers, you need to add specific labels to each service in your `docker-compose.yaml` file:
- `iobEnabled` (default: `true`): If set to `false`, the container will not be managed by the Docker plugin.
- `iobStopOnUnload` (default: `true`): If set to `false`, the container will continue running even if the corresponding ioBroker instance is stopped or unloaded.
- `iobBackup`: Specifies the names of Docker volumes that should be included in ioBroker backups. You can list multiple volumes separated by commas.
- `iobAutoImageUpdate`: If set to `true`, the plugin will automatically update the Docker image when a new version is available.
- `iobMonitoringEnabled`: (default: `false`): If set to `true`, the plugin will monitor the container's status and restart it if it stops unexpectedly.
- `iobWaitForReady`: (default: `false`): If set to `true`, the plugin will wait for a signal from instance to start the container. This is useful if the container depends on some files or configuration that needs to be prepared by the instance before starting.
- `iobCopyVolumes`: Specifies volume mappings that should be copied from the adapter directory to the container. The format is `source=>destination`, where `source` is a path relative to the adapter directory, and `destination` is the name of the Docker volume. You can list multiple mappings separated by commas.

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

## Changelog

### **WORK IN PROGRESS**
* (@GermanBluefox) initial release
