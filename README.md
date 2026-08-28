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
- Ensure containers stay aligned with the instance configuration
- Automate startup, teardown, and updates without writing custom scripts

## Prerequisites

- Node.js 20+
- Docker Engine 20.10+

## Minimal Configuration (`io-package.json`)

Add the following to the `common.plugins` section:

```json5
{
    // ...
    "common": {
        // ...
        "plugins": {
            "docker": {
                "iobDockerComposeFiles": ["docker-compose.yaml"],
                "iobDockerApi": "default", // optional
            }
        }
        // ...
    }
    // ...
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
        # If container_name is omitted, a default name is used: iob_<adapterName>_<instance>
        image: influxdb:2
        labels:
            # ioBroker-specific control (see a section below)
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
            - flux_data:/var/lib/influxdb2 # All volume names will be prefixed with `iob_<adapterName>_<instance>_`
            - flux_config:/etc/influxdb2
        networks:
            - true # Use the default shared network name: `iob_<adapterName>_<instance>`. Otherwise, the name is prefixed with `iob_<adapterName>_<instance>_`. The only exception is network `iobroker`, which is used as-is.
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
            - grafana_data:/var/lib/grafana # All volume names will be prefixed with `iob_<adapterName>_<instance>_`
            - grafana_provisioning:/etc/grafana/provisioning
        networks:
            - true # Use the default shared network name: `iob_<adapterName>_<instance>`. Otherwise, the name is prefixed with `iob_<adapterName>_<instance>_`. The only exception is network `iobroker`, which is used as-is.
        restart: unless-stopped

networks:
    true: # Literal "true" selects the standardized network name `iob_<adapterName>_<instance>`
        driver: bridge

volumes:
    flux_data:
    flux_config:
    grafana_data:
    grafana_provisioning:
```

## ioBroker-Specific Labels

Add these labels under each service to control behavior:

- `iobEnabled` (**required**, no default)
  Managing a service is an explicit opt-in: it is only created and started if this label is set to `true`. A service without the label — or with `false` — is left untouched, so a Compose file can contain services that the plugin must not manage.
  Typically wired to an adapter setting: `iobEnabled=${config.dockerInflux.enabled:-true}`.
- `iobStopOnUnload` (default: `false`)
  Set it to `true` to stop the container when the instance stops or is unloaded. Like `iobEnabled`, this is an opt-in: without the label — or with `false` — the container keeps running, so a service that other instances use as well is not torn down behind their back.
  See [Stopping containers on unload](#stopping-containers-on-unload) if your container needs longer than a second to stop.
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

## Stopping containers on unload

Containers labeled with `iobStopOnUnload=true` are stopped when the instance is stopped or disabled — and only those. The plugin does this in its `destroy()` hook, which the js-controller awaits before the adapter process terminates.

That wait is not unlimited. Once the host has requested the stop, it kills the adapter process after `common.stopTimeout` milliseconds — **1000 by default** — and the adapter itself spends 500 ms of that on its own shutdown. The plugin therefore issues all stops in parallel and skips every avoidable Docker round trip, but it does **not** shorten the grace period of the containers: that is what `stop_grace_period` is for, and cutting it short risks data loss for databases.

If your containers need longer than that to shut down cleanly, raise the timeout in the `common` section of your adapter's `io-package.json`:

```json
{
    "common": {
        "stopTimeout": 15000
    }
}
```

Pick a value that covers the `stop_grace_period` of your slowest container plus a little headroom. Without it the container may still be running when the adapter process is killed.

## Probing Docker Availability (`quiet`)

`DockerManager` can also be used on its own, without the plugin mechanism, to find out whether Docker
is usable on this host. The `checkDocker` control of a jsonConfig dialog does exactly that, through
the admin instance that serves the dialog:

```js
const dockerManager = new DockerManager({ logger, namespace: 'admin.0', quiet: true });
const info = await dockerManager.getDockerDaemonInfo();
await dockerManager.destroy();
```

The constructor starts the detection right away, so on a host without Docker every created manager
writes `Docker is not installed. Please install Docker.` into the log of the *asking* adapter - and a
config dialog with two such checkboxes creates two of them, although that adapter was never asked to
run a container. With `quiet: true` these messages go to the debug log instead; the result is
returned by `getDockerDaemonInfo()` anyway, and the caller reports it in its own UI.

Leave `quiet` unset for a manager that runs containers: there a missing Docker means the containers
will not start, and the user has to see it.

## Best Practices

- Keep Compose files minimal—only declare what you manage via the adapter.
- Raise `common.stopTimeout` when containers need more than a second to stop—see [Stopping containers on unload](#stopping-containers-on-unload).
- Use explicit named volumes for persistent data you want backed up.
- Avoid hard-coding secrets; prefer environment variables injected via adapter config.
- Test changes on a staging instance before rolling into production.

<!--
  Placeholder for the next version (must start at line-begin):
  ### **WORK IN PROGRESS**
-->

## Changelog
### **WORK IN PROGRESS**
- (@GermanBluefox) Fixed the endless recreation of containers that use `expose`, `env_file`, a tmpfs volume or `network_mode: service:<name>`: those settings cannot be read back from `inspect`, so every check reported them as changed and recreated the container - on every adapter start, and with `iobWaitForReady` on every readiness signal
- (@GermanBluefox) Fixed the check aborting for a container whose configuration holds a setting the running container does not have at all (a `healthcheck` or `dns` entry, a later added `stop_grace_period`): reading it off the missing object threw, so the container was neither recreated nor started nor monitored. A missing setting is now a difference like any other
- (@GermanBluefox) `healthcheck` is now really applied - it was parsed from the compose file and then dropped, on both the API and the CLI driver
- (@GermanBluefox) `dns`, `dns_search` and `dns_opt` are now really applied - the API driver had them commented out and the CLI driver never rendered them
- (@GermanBluefox) `env_file` now works on the API driver as well: the files are read and merged into the environment, as compose does it, with `environment:` winning over the file. Before, only the CLI driver honoured them, so the same compose file behaved differently depending on whether the host offers a docker socket
- (@GermanBluefox) `expose` and tmpfs volumes are now passed to docker on both drivers
- (@GermanBluefox) Resource limits are read from the compose file: `mem_limit`, `mem_reservation`, `memswap_limit`, `cpus`, `cpu_shares`, `cpu_quota`, `cpu_period`, `cpuset` and `pids_limit`, with `deploy.resources.limits` as a fallback. Only `shm_size` was evaluated before
- (@GermanBluefox) Fixed `cpus`: the fraction of a CPU was sent as a cpu *set*, which docker rejects. It is now sent as `NanoCpus`, and `cpuset` as `CpusetCpus`
- (@GermanBluefox) The CLI driver no longer builds its command line as a string that a shell has to split again: docker is called with an argument list. Values containing a space - an adapter directory below `C:\Program Files`, a password with a blank, a bind mount path, a healthcheck command - arrive as one argument now, and a value can no longer be interpreted as a shell command. This affects `docker cp` of the `iobCopyVolumes` provisioning, all container, volume and network commands, and `docker run` itself
- (@GermanBluefox) Fixed a multi-element `entrypoint` on the CLI driver: `--entrypoint` takes a single value, the remaining elements belong behind the image. They used to be joined into one value, which docker looked for as a single executable
- (@GermanBluefox) A configuration value that contains a template pattern itself no longer loops forever and blocks the adapter start - it is reported as an error
- (@GermanBluefox) Documented `iobStopOnUnload` correctly: like `iobEnabled` it is an opt-in and defaults to *not* stopping the container. The README claimed the opposite
- (@GermanBluefox) Removed a leftover `console.log` that wrote past the ioBroker logger on every check of every container

### 1.1.3 (2026-08-19)
- (@GermanBluefox) Added the `quiet` option to `DockerManager`: a manager created only to probe whether Docker is available now reports its absence on debug level instead of warn/error, so a pure availability check does not fill the log of an adapter that runs no container
- (@GermanBluefox) The failed probe of `/var/run/docker.sock` no longer goes to the console, but into the debug log of the adapter - it is a normal outcome on a host that uses the CLI, TCP, or has no Docker

### 1.1.2 (2026-08-15)
- (@GermanBluefox) Fixed the adapter hanging on the first start: creating a container went through `dockerode.run()`, which waits for the container to exit and therefore never returned for a long-running container
- (@GermanBluefox) Split `containerRun()` (starts detached) from the new `containerRunAndWait()` (runs a short-lived container and returns its output). Reading volume directories and files uses the latter and no longer detaches, which also fixes it on the CLI driver
- (@GermanBluefox) Documented `iobEnabled` correctly: it is a required opt-in, a service is only managed if the label is set to `true`. Services without it are now logged on debug level instead of being skipped silently
- (@GermanBluefox) Fixed `iobStopOnUnload`: the plugin did not implement `destroy()`, so containers were never stopped when the instance unloaded
- (@GermanBluefox) Containers are now stopped in parallel and without the surrounding container listings, to fit into the shutdown timeout of the host
- (@GermanBluefox) Applied `network_mode` from the compose file, including `container:<name>` and `service:<name>`
- (@GermanBluefox) Fixed resolution of `networks`: entries declared in the top-level `networks` block, the `true` shorthand and option-less entries of the mapping form were dropped silently
- (@GermanBluefox) Networks beyond the first one are now connected to the container, external networks are used verbatim

### 1.0.4 (2026-08-07)
- (@GermanBluefox) Better interpretation of docker-compose files

### 1.0.3 (2026-04-14)
- (@GermanBluefox) Added support for shm_size

### 1.0.1 (2026-03-19)
- (@GermanBluefox) Code refactoring.
- (@GermanBluefox) Do not start a manager if no one container is enabled

### 0.2.3 (2026-03-14)
- (@GermanBluefox) Remove one log line to avoid confusion

### 0.2.2 (2026-02-12)
- (@GermanBluefox) Added the restarting option

### 0.2.1 (2026-02-09)
- (@GermanBluefox) Correcting compare of existing and desired container configuration to avoid unnecessary restarts
- (@GermanBluefox) Allowed using entrypoints without a command

### 0.1.7 (2025-12-06)
- (@GermanBluefox) Packages updated

### 0.1.6 (2025-10-15)
- (@GermanBluefox) Added support of old volumes with `dockerode` library

### 0.1.5 (2025-10-09)
- (@GermanBluefox) Added `${instance}` variable to be used in docker-compose files

### 0.1.4 (2025-10-09)
- (@GermanBluefox) Added a text file read from volume

### 0.1.3 (2025-10-09)
- (@GermanBluefox) Split the docker manager into pure docker commands and monitoring of own containers

### 0.0.3 (2025-09-25)

- (@GermanBluefox) initial release
