# Docker Plugin for ioBroker

A lightweight plugin that lets ioBroker define, start, update, monitor, and optionally back up Docker containers declared via Docker Compose files. It translates adapter configuration values into container settings and keeps containers in sync with your instance configuration.

## Highlights

- Define one or more Docker Compose files per ioBroker instance
- Dynamic variable substitution from adapter config (e.g. `${config.dockerInflux.enabled}`)
- Automatic (re)creation of containers when configuration changes
- Optional image auto-update & basic health monitoring
- Graceful stop on instance unload (configurable per container)
- Backup integration for declared data volumes
- Pre‑start file provisioning (copy local dirs into named volumes)
- Unified network & naming scheme to avoid collisions

## When to Use This Plugin

Use it if you want to:

- Ship recommended Dockerized services together with an ioBroker adapter (e.g. InfluxDB + Grafana)
- Ensure containers stay aligned with instance configuration
- Automate startup, teardown, and updates without writing custom scripts

## Prerequisites

- Node.js 20+
- Docker Engine 20.10+

## Minimal Configuration (`io-package.json`)

Add the following to the `common.plugins` section:

```json
"plugins": {
  "docker": {
    "iobDockerApi": "default",
    "iobDockerComposeFiles": ["docker-compose.yaml"]
  }
}
```

Field notes:

- `iobDockerApi` (optional): Name of a Docker connection defined under `system.docker => native`. You may also use a pattern like `${config.dockerApiName}` to reference adapter config.
- `iobDockerComposeFiles`: Array of relative paths (from the adapter root directory) to Docker Compose files.

## Docker Compose File Basics

Paths listed in `iobDockerComposeFiles` are resolved relative to the adapter's installation directory inside ioBroker. A typical `docker-compose.yaml`:

```yaml
version: '3.9'

services:
    influx:
        # If container_name is omitted a default is used: iob_<adapterName>_<instance>
        image: influxdb:2
        labels:
            # ioBroker-specific control (see section below)
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
        networks:
            - true # Use the default shared network name
        restart: unless-stopped

    grafana:
        image: grafana/grafana-oss
        labels:
            - 'iobEnabled=${config.dockerInflux.enabled:-true}'
            - 'iobStopOnUnload=${config.dockerInflux.stopIfInstanceStopped:-true}'
            - 'iobCopyVolumes=./grafana-provisioning=>grafana_provisioning'
            - 'iobWaitForReady=true'
        container_name: grafana
        depends_on:
            - influx
        ports:
            # Use underscore variant for nested config paths that otherwise confuse validation
            - '${config.dockerGrafana.bind:-127.0.0.1}:${config_dockerGrafana_port:-3000}:3000'
        environment:
            GF_SECURITY_ADMIN_PASSWORD: '${config.dockerGrafana.adminSecurityPassword:-iobroker}'
            GF_SERVER_ROOT_URL: '${config.dockerGrafana.serverRootUrl:-}'
            GF_INSTALL_PLUGINS: '${config.dockerGrafana.plugins:-}'
            GF_USERS_ALLOW_SIGN_UP: '${config.dockerGrafana.usersAllowSignUp:-false}'
        volumes:
            - grafana_data:/var/lib/grafana
            - grafana_provisioning:/etc/grafana/provisioning
        networks:
            - true
        restart: unless-stopped

networks:
    true: # Literal "true" selects the standardized network name iob_<adapterName>_<instance>
        driver: bridge

volumes:
    flux_data:
    flux_config:
    grafana_data:
    grafana_provisioning:
```

## ioBroker-Specific Labels

Add these labels under each service to control behavior:

- `iobEnabled` (default: `true`)
  Disable management for a service by setting to `false`.
- `iobStopOnUnload` (default: `true`)
  If `false`, the container keeps running when the instance stops or is unloaded.
- `iobBackup`
  Comma‑separated list of named volumes to include in ioBroker backups.
- `iobAutoImageUpdate` (default: `false`)
  If `true`, the plugin pulls and recreates the container when a newer image is available.
- `iobMonitoringEnabled` (default: `false`)
  Basic status monitoring; restarts container if it exits unexpectedly.
- `iobWaitForReady` (default: `false`)
  Delay container start until the adapter signals readiness (useful for generated config files).
- `iobCopyVolumes`
  Copy (one time or when changed) local directories into named volumes. Format: `relative/path=>docker_volume[,another=>vol2]`.

## Variable Substitution

You can inject adapter config values into Compose using `${config.<path>}`. For some deeply nested keys or those containing dots, a transformed alias like `config_dockerGrafana_port` may be required to bypass validator constraints. Both syntaxes resolve to adapter configuration values.

Fallback syntax `${varName:-default}` is supported; the default is used if the referenced config value is empty or undefined.

## Naming & Networks

- Container names: If you omit `container_name`, the plugin generates `iob_<adapterName>_<instance>_<service>` (service part may be implicit).
- Network: Using `true` inside the `networks:` list signals: attach to the shared network `iob_<adapterName>_<instance>`.
- Custom network names that are not standard receive the `iob_<adapterName>_<instance>_` prefix for isolation.

## Volume Copying Workflow (`iobCopyVolumes`)

1. Container creation is paused if `iobWaitForReady=true`.
2. The adapter prepares provisioning files locally.
3. The plugin copies the specified directories into the declared named volumes.
4. Container starts once the adapter signals readiness.

## Auto Image Updates

If `iobAutoImageUpdate=true`, the plugin periodically (or on trigger) checks the registry for a newer tag (same literal tag as declared). On change: pulls, stops container (respecting stop policy), recreates with existing settings, and restarts.

## Backups

Volumes listed in `iobBackup` are tagged for inclusion in ioBroker backup routines. Ensure they are named volumes (not anonymous or host bind mounts) for reliable restore.

## Best Practices

- Keep Compose files minimal—only declare what you manage via the adapter.
- Use explicit named volumes for persistent data you want backed up.
- Avoid hard-coding secrets; prefer environment variables injected via adapter config.
- Test changes on a staging instance before rolling into production.

<!--
  Placeholder for the next version (must start at line-begin):
  ### **WORK IN PROGRESS**
-->

## Changelog
### 0.0.3 (2025-09-25)

- (@GermanBluefox) initial release
