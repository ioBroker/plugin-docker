# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@iobroker/plugin-docker` is an ioBroker plugin that manages Docker containers declared via Docker Compose files. It parses Compose YAML/JSON/JSON5 files, substitutes adapter config values using template variables (`${config.path}` or `${config_path}`), converts them into `ContainerConfig` objects, and manages container lifecycle via the Docker API (using `dockerode`).

## Build & Development Commands

```bash
npm run build        # TypeScript compile → build/esm, then esm2cjs → build/cjs, then tasks.js copies types/package.json
npm run lint         # ESLint with @iobroker/eslint-config
npm test             # Integration tests via mocha (requires build first: tests import from build/cjs)
```

## Architecture

The plugin has a pipeline: **Compose file → parsed structure → ContainerConfig[] → Docker API calls**.

- **`src/index.ts`** — `DockerPlugin` (extends `PluginBase`). Entry point. Reads Compose files (YAML/JSON/JSON5), applies template substitution, converts to `ContainerConfig[]`, and initializes `DockerManagerOfOwnContainers`.
- **`src/lib/parseDockerCompose.ts`** — Parses raw YAML into a typed `ComposeTop` structure (services, networks, volumes).
- **`src/lib/compose2config.ts`** — Converts `ComposeTop` into an array of `ContainerConfig` objects, mapping Compose fields to the internal normalized format.
- **`src/lib/templates.ts`** — Template engine for variable substitution. Supports `${config.path:-default}`, `${config_path:-default}`, `{{config.path}}`, and `${instance}`. Walks an entire config tree recursively.
- **`src/lib/DockerManager.ts`** — Low-level Docker operations using `dockerode`. Handles container CRUD, image pull, network/volume management, stats monitoring, file operations on volumes, and SSH tunneling.
- **`src/lib/DockerManagerOfOwnContainers.ts`** — Higher-level orchestrator (extends `DockerManager`). Compares desired vs. existing container state, creates/recreates containers as needed, handles volume copy provisioning, monitoring, and graceful stop on unload.
- **`src/types.d.ts`** — All shared TypeScript interfaces (`ContainerConfig`, `DockerContainerInspect`, `ContainerInfo`, etc.).

## Dual-format Publishing

The package ships both ESM (`build/esm/`) and CJS (`build/cjs/`). The `postbuild` script uses `esm2cjs` for conversion, then `tasks.js` copies `types.d.ts` and `package.json` into both output dirs and patches the CJS `index.js` to add `module.exports` compatibility.

## Testing

Tests are in `test/` and run against the CJS build output. You must `npm run build` before running `npm test`. Test fixtures are `test/docker-compose-*.yaml` files with sample Compose configurations.

## ioBroker-Specific Labels

Compose services use custom labels (prefixed `iob`) to control plugin behavior: `iobEnabled`, `iobStopOnUnload`, `iobAutoImageUpdate`, `iobMonitoringEnabled`, `iobWaitForReady`, `iobBackup`, `iobCopyVolumes`. These are extracted during `composeToContainerConfigs` and become fields on `ContainerConfig`.

## Naming Conventions

Container names, volume names, and network names are prefixed with `iob_<adapterName>_<instance>_` to avoid collisions. Network named `true` maps to the default shared network `iob_<adapterName>_<instance>`. Network named `iobroker` is used as-is.
