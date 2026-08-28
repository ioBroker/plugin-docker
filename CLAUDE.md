# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@iobroker/plugin-docker` is an ioBroker plugin (loaded by js-controller via `common.plugins.docker` of an adapter's `io-package.json`) that manages Docker containers declared in Docker Compose files shipped with the adapter. It parses Compose YAML/JSON/JSON5, substitutes adapter config values into it, converts services into `ContainerConfig` objects and keeps the containers in sync with the instance configuration.

`DockerManager` is also usable standalone, without the plugin mechanism — e.g. admin's `checkDocker` jsonConfig control probes Docker availability with it; see the `quiet` option in the README.

## Build & Development Commands

```bash
npm run build                          # tsc -p tsconfig.build.json → build/esm, then esm2cjs → build/cjs, then node tasks
npm run lint                           # ESLint with @iobroker/eslint-config (test/**/*.js and build/ are excluded)
npm test                               # = test:integration = mocha --exit  (glob: ./test/*.js, NOT recursive)
npx mocha --exit test/networks.test.js # run one test file
npx mocha --exit --grep "iobEnabled"   # run one suite/test by name
```

**You must `npm run build` before `npm test`.** The tests are plain CommonJS and require from `build/cjs/...`, so a source change is invisible to them until rebuilt.

## Architecture

Pipeline: **Compose file → `ComposeTop` → `ContainerConfig[]` → Docker API/CLI calls**.

- **`src/index.ts`** — `DockerPlugin extends PluginBase`. Reads the instance object, runs template substitution over the plugin config and each Compose file, converts to `ContainerConfig[]`, and starts `DockerManagerOfOwnContainers`. Also re-exports `DockerManager`, `DockerManagerOfOwnContainers` and the public types.
- **`src/lib/parseDockerCompose.ts`** — YAML text → typed `ComposeTop` (services, networks, volumes).
- **`src/lib/compose2config.ts`** — `ComposeTop` → `ContainerConfig[]`; maps ports/volumes/networks/healthcheck/restart/resources and lifts the `iob*` labels out of `labels` into dedicated fields.
- **`src/lib/templates.ts`** — `walkTheConfig()` recurses over the whole parsed tree and applies `parseField()` to every string. Syntaxes: `{{config.a.b}}`, `${config.a.b:-default}`, `${config_a_b:-default}` (underscore alias for jsonConfig validators), `${instance}`. If the pattern *is* the whole string, the raw (non-string) value is returned — that is how booleans and numbers survive.
- **`src/lib/DockerManager.ts`** — all low-level Docker operations: containers, images, networks, volumes, stats, file operations inside volumes, SSH tunneling.
- **`src/lib/DockerManagerOfOwnContainers.ts`** — orchestrator on top of it: desired-vs-existing reconciliation, volume provisioning, monitoring, stop on unload.
- **`src/types.d.ts`** — every shared interface (`ContainerConfig`, `DockerContainerInspect`, `ContainerInfo`, …). Copied verbatim into both build outputs by `tasks.js`.

### Two transports in DockerManager (the most important structural fact)

`init()` probes, in order: an explicit `dockerApi` host/port → `/var/run/docker.sock` → `http://127.0.0.1:2375` → `https://127.0.0.1:2376` → the `docker` CLI. The first four give a `dockerode` instance (`#dockerode`), the last sets `#driver = 'cli'`.

**Almost every method therefore has two branches**: `if (this.#dockerode) { … } else { … this.#exec([…]) }`. When adding or changing an operation, implement *both* paths and keep their return shapes identical — callers and tests do not know which driver is active.

`#exec` takes an **argument list and runs `docker` through `execFile`, without a shell** (prefixed with `sudo` when `needSudo`). It has no string form on purpose: every command carries values from the compose file — names, environment values, bind mount paths — and a joined command line broke on every space and would execute a shell metacharacter. `toDockerRunArgs()` builds the list; `toDockerRun()` renders the same list as a quoted string for logs and for external callers. A test in `configMapping.test.js` fails if a `#exec` call is written with a template string again.

Related gotchas:
- `containerRun()` starts detached; `containerRunAndWait()` runs a short-lived container and returns its output. Never use `dockerode.run()` for a long-running container — it resolves only when the container exits (this hung the adapter, see changelog 1.1.2).
- `logDockerUnavailable()` routes "Docker is missing" messages to `warn`/`error`, or to `debug` when the manager was constructed with `quiet: true`.

### Reconciliation loop (`DockerManagerOfOwnContainers`)

`init()` → `#checkOwnContainers()`, per container: ensure networks exist → ensure named volumes exist (running `iobCopyVolumes` provisioning on creation, or on every check with `(force)`) → pull or update the image → if the container exists, `#ensureActualConfiguration()`, else create and start it → connect secondary networks → start a 60 s monitoring interval if any container has `iobMonitoringEnabled`.

`#ensureActualConfiguration()` inspects the running container, maps it back through `mapInspectToConfig()` and feeds both sides to `compareConfigs()`; **any diff recreates the container**. That makes the desired/existing mapping the most delicate part of the codebase:

- Every field added to `ContainerConfig` must round-trip symmetrically: compose → config → docker → `mapInspectToConfig` → the same value. An asymmetric field recreates the container on *every* check, forever. If it cannot round-trip, add it to `ignoredOnCompare` instead — never leave it half-mapped.
- `dockerDefaults` and `cleanContainerConfig()` normalize away values Docker fills in itself.
- `ignoredOnCompare` and all `iob*` keys are excluded from the comparison. `networks` is there because it is reconciled by connecting the missing ones to the *running* container (the creation network is still compared through `networkMode`); `expose`, `tmpfs`, `envFile`, `networkContainer` and `build` because Docker does not report them back in the form they were written. The file documents the reason per key.
- A key whose object is missing on the existing side counts as a difference. It must not throw — that used to abort the whole check of the container, leaving it unstarted and unmonitored.
- `env_file` is resolved into `environment` by `#resolveEnvFiles()` before create and compare, because Docker itself has no `env_file` (only the CLI driver has a flag for it).
- Mounts, volumes and ports are sorted before comparing, volume paths like `/var/lib/docker/volumes/<name>/_data` are folded back to `<name>`, and `network_mode: container:<name>` is resolved to `container:<id>` because that is what inspect reports.

### Startup and shutdown timing

- If any container has `iobWaitForReady`, the manager is **not** started in `init()`. The adapter has to call `plugin.instanceIsReady()` once it has written its provisioning files.
- `destroy()` is awaited by the js-controller's PluginHandler and stops the `iobStopOnUnload` containers in parallel, without surrounding container listings, because the host kills the adapter process `common.stopTimeout` ms (1000 by default) after requesting the stop. Do not add Docker round trips there. See the README section "Stopping containers on unload".

### `iobEnabled` is an opt-in gate

`src/index.ts` filters on a truthy `config.iobEnabled`: a service without the label is *not* managed. Do not relax it to `!== false` (there is an explicit comment at that line) — Compose files may legitimately contain services this plugin must leave alone.

## Naming Conventions

The prefix is `iob_${namespace.replace(/[-.]/g, '_')}`, i.e. `iob_<adapterName>_<instance>`. Container, volume and network names become either that prefix (when the name is `true` or missing) or `<prefix>_<name>`. Used verbatim instead: the network `iobroker`, external networks, and the reserved modes `host`, `bridge`, `none`, `container:<name>` — though the *target* of `container:` follows the renaming of the container it points to.

## ioBroker-Specific Labels

`iobEnabled` (required opt-in), `iobStopOnUnload` (opt-in as well: a missing label means the container keeps running), `iobAutoImageUpdate`, `iobMonitoringEnabled`, `iobWaitForReady`, `iobBackup` (comma-separated volume names → `mount.iobBackup`), `iobCopyVolumes` (`local/path=>volume[(force)][,…]`, `->` also accepted → `mount.iobAutoCopyFrom`). `composeServiceToContainerConfig` strips them from `labels` and puts them on the config; only the literal strings `'true'`/`'false'` become booleans, everything else stays a string and is evaluated truthy. The README documents the user-facing semantics and defaults — keep both in sync when changing them.

## Dual-format Publishing

The package ships ESM (`build/esm/`) and CJS (`build/cjs/`). `postbuild` runs `esm2cjs`, then `tasks.js` copies `src/types.d.ts` and `package.json` into both output dirs and rewrites `build/cjs/index.js` so `module.exports` is `DockerPlugin` itself, with `DockerManager`, `DockerManagerOfOwnContainers` and `default` hung off it. Renaming those exports in `src/index.ts` requires updating `tasks.js` too — its `String.replace` fails silently otherwise.

## Testing

`test/*.js` are CommonJS mocha tests against the CJS build, with `test/docker-compose-*.yaml` fixtures. They tolerate both export shapes (`Module.default || Module`).

`test/helpers/` is deliberately outside mocha's glob: `fake-dockerode-run.js` patches module resolution to inject a fake `dockerode` and is spawned as a child process by `containerRun.test.js`, so it must never be loaded into the test process itself. CI runners have a real Docker daemon — tests must never rely on the absence of one (see `quiet.test.js`, which stubs `init` instead of probing the host).

## Releasing

`npm run release-patch|-minor|-major` (`@alcalzone/release-script`). The changelog lives in `README.md`, and the placeholder comment block near its end (`### **WORK IN PROGRESS**`) must stay intact — the script replaces it. Pushing a `v<x.y.z>` tag triggers the npm deploy job in `.github/workflows/test-and-release.yml`.
