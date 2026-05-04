# DockerProvider — Local Workspace Provisioning

**Status:** Draft (design phase, not yet planned)
**Date:** 2026-05-04
**Branch:** `feat/docker-provider`
**Scope:** Add a `DockerProvider` to `be/`'s provider abstraction so workspaces created from a local dev backend run as Docker containers on the dev machine instead of provisioning real Fly.io machines against the production Fly account.

---

## Problem

Today, when a developer runs `pnpm dev` against `be/` and clicks "Create Server" in the local client, `ServerService.createServer()` calls `getProvider('fly')` → `FlyProvider.createMachine()`, which hits the **real Fly.io Machines API** using `FLY_API_TOKEN` from the developer's local `be/.env`. This produces a billable production Fly machine in the `fishtank-workspaces` org for every local "Create Server" click. There is no local-only path.

The `IProvider` abstraction in `be/src/api/services/providers/` was designed for multiple providers, but only `FlyProvider` is registered.

## Goals

- Local "Create Server" clicks provision a Docker container on the developer's machine instead of a Fly.io machine.
- Lifecycle for the everyday create/start/stop/restart/delete loop works correctly.
- Workspace data persists across container restart and `be` restart (Level B from brainstorming).
- Selection between Docker and Fly is controlled per-process via env var, defaulting to `docker` in dev and `fly` in production.

## Non-Goals

- **Snapshots, forking, restore-from-snapshot.** The DockerProvider throws a clear error if these are called. Developers who need to test these flows set `LOCAL_PROVIDER=fly`.
- **Public preview URLs.** Workspaces are reachable on `http://localhost:<port>` only; no Cloudflare tunnel / DNS / cert plumbing.
- **Auto-suspend on idle.** Containers stay running until explicitly stopped.
- **Multi-region.** A single synthetic `local` region.
- **Cross-machine migration** (`changeRegion`).
- **UI changes / per-server provider picker.** The provider is selected at the backend level via env var; no Create Server dialog changes.

---

## Architecture

### Provider selection

`getDefaultProviderId()` in `be/src/api/services/providers/registry.ts` becomes:

```ts
export function getDefaultProviderId(): ProviderId {
  if (process.env.LOCAL_PROVIDER === 'docker') return 'docker';
  if (process.env.LOCAL_PROVIDER === 'fly') return 'fly';
  if (process.env.NODE_ENV !== 'production') return 'docker';
  return 'fly';
}
```

Both providers are always registered in `initProviders()`. Selection is purely about which one `getDefaultProviderId()` returns. `LOCAL_PROVIDER` is the per-process override; useful when a developer wants to debug a Fly-specific bug from a local backend without flipping `NODE_ENV`.

### Type changes

- `ProviderId` (in `types.ts`) extends from the literal `'fly'` to the union `'fly' | 'docker'`.
- `HOURLY_RATES` in `registry.ts` gains a `docker` entry with all tier rates set to `0` (local provisioning is free for billing purposes; usage events still fire but bill at $0).

### Files touched

- `be/src/api/services/providers/types.ts` — extend `ProviderId`.
- `be/src/api/services/providers/registry.ts` — register `DockerProvider`, update default selection, add zero-cost rates.
- `be/src/api/services/providers/DockerProvider.ts` — **new file** (the bulk of the work).
- `be/src/api/services/providers/index.ts` — re-export.
- `be/.env.example` — document `LOCAL_PROVIDER`, `RUNHQ_WORKSPACE_IMAGE`, `RUNHQ_WORKSPACE_DOCKERFILE_DIR`.
- `be/package.json` — add `dockerode` and `@types/dockerode`.

No DB migration. The `servers.providerId` column already accepts arbitrary strings; the existing `flyMachineId` column stores the Docker container ID (12-char short ID, fits the column width), and `flyAppName` is repurposed to store the **host port** as a string (e.g., `"54321"`). This is the only persistence channel available — `IProvider.getRoutingInfo` is synchronous per its contract, so we cannot read the host port via a `docker inspect` call from inside it. The existing callers (7 sites in `HttpServer.ts` + `ServerService.ts`) already pass `server.flyAppName` as the second argument, so the persisted port is available wherever needed.

---

## DockerProvider behavior

`DockerProvider` implements `IProvider` using the `dockerode` npm client (chosen over shelling out to the `docker` CLI: typed responses, no string parsing of `docker inspect`, easier to mock in tests).

### Configuration

| Method | Behavior |
|---|---|
| `isConfigured()` | Synchronous: returns `true` if `/var/run/docker.sock` exists and is a socket file (`fs.statSync` + `isSocket()`). Returns `false` otherwise. The actual liveness check (`docker.ping()`) happens lazily inside `createMachine`, which throws a clear `Docker is not running` error if the daemon is not responding. Keeping `isConfigured` sync matches the existing `IProvider` contract and avoids cascading async changes through `registry.ts` callers. |
| `getRegions()` | Returns `[{ id: 'local', providerId: 'docker', providerRegion: 'local', displayName: 'Local Docker' }]`. |
| `getTierSpecs()` | Returns the same tier list the Fly provider exposes. Local users see the same tier choices in any UI that calls `getTierSpecs()`. |

### App lifecycle

Docker has no per-tenant network isolation requirement locally (the existing per-tenant Fly app + 6PN network model exists for cloud isolation; locally everything is on the developer's machine). All four methods are no-ops:

| Method | Behavior |
|---|---|
| `createApp(appName, networkName)` | Returns immediately. |
| `deleteApp(appName)` | Returns immediately. |
| `allocateIPs(appName, opts)` | Returns immediately. |
| `addCertificate(appName, hostname)` | Returns immediately. |

Idempotent by virtue of doing nothing.

### Machine lifecycle

#### `createMachine(opts)`

1. Resolve image ref:
   - `process.env.RUNHQ_WORKSPACE_IMAGE` if set, otherwise `runhq-server:local`.
2. Ensure image is present:
   - `docker images <ref>` lookup. If absent and ref ends with `:local`, lazy-build:
     - Source dir: `process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR` or `path.resolve(process.cwd(), '../runhq/server')`.
     - Build via `dockerode.buildImage()` with that context, tag `runhq-server:local`.
     - First-time build cost (~minutes) is paid once; subsequent creates use the cached image.
   - If absent and ref does NOT end with `:local`, throw — caller is expected to have pulled / built the explicit image themselves.
3. Allocate a free host port via `net.createServer().listen(0)` → record port → close listener.
4. `dockerode.createContainer({...})`:
   - Image: resolved ref.
   - Env: `SERVER_TOKEN`, `CLOUD_API_URL` (passed through from the `be` process), `PORT=61987` (matches prod's hardcoded server port), `NODE_ENV=production` (so the workspace binary behaves like prod inside the container — it just happens to be running on the dev host).
   - Mounts: bind mount `/app/data/local-workspaces/<volumeId>` → `/app/data` (the workspace's filesystem).
   - PortBindings: `61987/tcp` → host's allocated port.
   - HostConfig: `NanoCpus` and `Memory` derived from `tier`, `RestartPolicy: { Name: 'unless-stopped' }`, default network mode (`bridge`).
   - Labels:
     - `runhq.managed=true`
     - `runhq.serverId=<serverId>`
     - `runhq.volumeId=<volumeId>`
     - `runhq.tier=<tierId>`
     - `runhq.hostPort=<allocatedPort>`
5. `container.start()`.
6. Return `ProvisionResult`:
   ```ts
   {
     machineId: container.id.slice(0, 12),  // matches Fly's 14-char machine ID column width
     machineName: <user-given name>,
     serverUrl: `http://localhost:${hostPort}`,
     region: 'local',
     volumeId,
     appName: String(hostPort),  // repurposed: stored in servers.flyAppName, read by getRoutingInfo
     networkName: null,
     providerMetadata: { hostPort, fullContainerId: container.id }
   }
   ```

The 12-char short ID is used as `machineId` everywhere downstream because the `servers.flyMachineId` column was sized for Fly's 14-char IDs. The full 64-char ID is stored in `providerMetadata` for cases that need it. The `appName` field carries the host port as a string so `getRoutingInfo(machineId, appName)` can synchronously reconstruct `http://localhost:<appName>` without needing a Docker round-trip.

#### State + info

| Method | Behavior |
|---|---|
| `getMachineState(id)` | `container.inspect()`. Map Docker's `State.Status` → `MachineState`: `running`→`running`, `paused`→`suspended`, `exited`/`created`→`stopped`, `restarting`→`starting`, `removing`→`destroying`, `dead`→`destroyed`. 404 → `'destroyed'`. |
| `getMachineInfo(id)` | Inspect, return normalized `MachineInfo` with `state`, `region: 'local'`, labels surfaced as metadata. On 404 (container removed externally), let the inspect error propagate — matches `FlyProvider.getMachineInfo` which has no explicit 404 path. Callers that need to tolerate "machine vanished" should use `getMachineState` (which maps 404 → `'destroyed'`) instead. |

#### Lifecycle ops

| Method | Behavior |
|---|---|
| `startMachine` | `container.start()` (idempotent — no-op if already running). |
| `stopMachine(id, opts)` | `container.stop({ t: 10 })`. The `disableAutostart` option is meaningless locally (no Fly edge to race) and is ignored. |
| `restartMachine` | `container.restart()`. |
| `suspendMachine` | `container.pause()`. |
| `updateMachineImage` | `container.stop()` → record labels/env/binds via `inspect()` → `container.remove()` → recreate with new image, same labels/env/volume bind/port. |
| `deleteMachine` | `container.stop({ t: 10 })` → `container.remove()`. Does **not** delete the volume directory; that's `deleteVolume`'s job. Mirrors Fly semantics. |

### Volumes

Backed by host-side bind mounts under `/app/data/local-workspaces/<volumeId>/`. `/app/data` is the persistent Fly volume on the dev machine, so workspace data survives reboots and overlay resets without extra plumbing.

| Method | Behavior |
|---|---|
| `createVolume(name, region, sizeGb, appName)` | Generate a UUIDv4 → `mkdir -p /app/data/local-workspaces/<id>` → `chmod 755`. Return `{ id, name, state: 'created', sizeGb, region: 'local' }`. `sizeGb` is recorded in metadata but not enforced (host fs has whatever space it has). |
| `getVolume(id)` | `fs.stat` the dir; return null if missing. |
| `extendVolume(id, newSizeGb)` | No-op. Logs once at info: `"DockerProvider does not enforce volume size; extend ignored"`. |
| `deleteVolume(id)` | `fs.rm(dir, { recursive: true, force: true })`. |
| `waitForVolumeReady` | Resolves immediately. |
| `createVolumeFromSnapshot`, `forkVolume`, `createSnapshot` | Throw `Error('Snapshots and volume forking are not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.')`. |

### Health, routing, env updates

| Method | Behavior |
|---|---|
| `waitForState(id, targets, timeoutMs)` | Poll `inspect()` every 500 ms until `state` matches one of `targets` or timeout (default 60 s). Throw on timeout with last observed state in the message. |
| `waitForHealthy(id, timeoutMs)` | Read `runhq.hostPort` label → poll `http://localhost:<port>/health` every 500 ms with a 2 s per-request timeout, until 200 OK or overall timeout (default 60 s). Throw on timeout. |
| `getRoutingInfo(id, appName)` | Read host port from `appName` (callers pass `server.flyAppName`, where the port string is persisted). Return `{ serverUrl: 'http://localhost:<appName>', routingToken: null, requiresRoutingHeaders: false }`. Throws if `appName` is missing/empty. The same value is also set on the container as label `runhq.hostPort` for `docker ps` debuggability, but `getRoutingInfo` does not read it (interface is sync; cannot await `inspect`). |
| `updateAutoSuspendPolicy` | No-op. |
| `updateMachineEnv(id, env)` | Inspect → record current config → stop → remove → recreate with merged env, same labels/volume/port. Docker doesn't allow live env changes; recreate is the only path. The container ID changes, so callers must read the new ID from `getMachineInfo` afterward. (The same ID-rotation already happens in some FlyProvider paths.) |

### Fleet listing

| Method | Behavior |
|---|---|
| `listMachines(appName)` | `dockerode.listContainers({ all: true, filters: { label: ['runhq.managed=true'] } })`. Map each entry to `MachineInfo`. The `appName` filter is ignored (no app concept locally). |

---

## Data flow

### Create Server (happy path)

1. User submits Create Server dialog in client.
2. Client → `be` → `ServerService.createServer(ownerId, opts)`.
3. `ServerService.createServer` calls `getProvider(getDefaultProviderId())` — which returns the `DockerProvider` instance because `NODE_ENV !== 'production'`.
4. `provisionNewMachine` calls `provider.createApp(appName, networkName)` → no-op.
5. `provider.allocateIPs(appName)` → no-op.
6. `provider.createVolume(name, region, sizeGb, appName)` → `mkdir /app/data/local-workspaces/<id>`.
7. `provider.createMachine({ serverId, serverToken, region, tier, existingVolumeId, ... })`:
   - Resolves image (lazy-builds `runhq-server:local` on first call).
   - Allocates host port.
   - Creates + starts container with bind mount, env, labels.
8. `provider.waitForState(id, ['running'], 60_000)`.
9. `provider.waitForHealthy(id, 60_000)` — polls `http://localhost:<port>/health`.
10. `provisionNewMachine` returns `{ machineId, machineName, url: 'http://localhost:<port>', region: 'local', volumeId }`.
11. `ServerService` writes the row to `servers` (with `providerId='docker'`, `flyMachineId=<container short ID>`, `flyAppName='<hostPort>'` — the port string lives in the `flyAppName` column so `getRoutingInfo` can reconstruct the URL synchronously after a `be` restart).
12. Client gets back the new server with `serverUrl: 'http://localhost:<port>'`.

### Boot recovery

After `be` restarts:
- Containers with `--restart=unless-stopped` are still running (Docker daemon owns them).
- `servers` rows still reference them by container ID, with the host port persisted in `flyAppName`.
- Next time the UI queries server state, `getMachineState(id)` reads live state from Docker; `getRoutingInfo(id, server.flyAppName)` reconstructs the URL from the persisted port without needing a Docker call.

No reaper, no startup migration, no in-memory cache, no special-case code.

---

## Error handling

| Failure | Behavior |
|---|---|
| Docker socket missing | `isConfigured()` returns `false` (sync `fs.statSync` check on `/var/run/docker.sock`). `initProviders()` logs a warning at startup. `createMachine` calls `docker.ping()` first and throws `Error('Docker is not running. Start Docker before creating workspaces.')` if the daemon doesn't respond — same shape as FlyProvider's "FLY_API_TOKEN missing" error. |
| Image build fails | `createMachine` throws with the build's stderr tail. No partial state — container is never created. |
| Free-port allocation race | `EADDRINUSE` from `docker create`: retry once with a fresh port from `net.createServer().listen(0)`. Beyond that, throw. |
| Container creation fails after volume dir was created | Volume dir is left in place (matches Fly semantics where volumes outlive machines). Caller's responsibility to call `deleteVolume` for cleanup. |
| `inspect()` 404 (container removed externally, e.g., `docker rm` from a terminal) | `getMachineState` returns `'destroyed'`. Existing `ServerService` logic handles `destroyed`-on-running paths. |
| `waitForHealthy` timeout | Throw `Error('Workspace did not become healthy within Xms')`. Same shape as FlyProvider. |
| `forkVolume` / `createSnapshot` / `createVolumeFromSnapshot` invoked | Throw the explicit not-supported error documented above. Better than silent stubs that would corrupt expected fork semantics. |

---

## Testing

### Unit tests — `be/src/api/services/providers/DockerProvider.test.ts`

Mock `dockerode` end-to-end. Verify each method makes the expected Docker API calls with correct arguments:

- `createMachine` produces a container spec with the right image, env, mounts, port mapping, labels, and resource limits (per-tier `NanoCpus`/`Memory`).
- `getMachineState` correctly maps every Docker state we care about.
- `deleteMachine` does not call `deleteVolume`.
- `forkVolume` etc. throw the documented error.
- `getRoutingInfo` reads from the `appName` argument (no Docker call); throws when missing.

### Integration tests — `be/src/api/services/providers/DockerProvider.integration.test.ts`

Gated behind `RUN_DOCKER_INTEGRATION=1` env var. Talks to a real Docker socket. Uses `alpine:latest` (~5 MB) labeled `runhq.managed=true` to exercise:

- Create → start → wait running → stop → delete.
- Volume create → bind mount visible inside container → delete cleans dir.
- Label-filtered `listMachines` returns only test container.

CI does not run this. Local developers can.

### One ServerService regression

In the existing `ServerService.test.ts` style: with `LOCAL_PROVIDER=docker` set and `dockerode` mocked, calling `ServerService.createServer()` produces the correct DB row and a `provisionResult.serverUrl` of `http://localhost:<port>`. Confirms the wiring through `getDefaultProviderId()`.

---

## Open questions / future work

- **Cleanup of orphan volume dirs.** If a server row is deleted from the DB but `deleteVolume` is never called (or fails partway), the bind dir under `/app/data/local-workspaces/<id>` is orphaned. Not in scope for this work; a future helper script can `du -sh /app/data/local-workspaces/*` and reconcile against the `servers` table.
- **Image rebuild trigger.** First-time lazy build is automatic; subsequent rebuilds (e.g., after editing `runhq/server/Dockerfile`) require either deleting the `runhq-server:local` tag or running an explicit rebuild. Could add a `RUNHQ_WORKSPACE_REBUILD=1` env var or a `pnpm rebuild-workspace` script. Out of scope for first version.
- **Public URL access.** Punted to a later spec. When/if needed, the cleanest approach is probably extending the existing tank.fish Cloudflare tunnel with dynamic ingress entries keyed by container ID, mirroring Fly's `*.fly.dev` model.
- **Snapshot/fork support (Level C).** Bind-mount layout makes it tractable: `cp -a /app/data/local-workspaces/<src>/ /app/data/local-workspaces/<dst>/` followed by recreating the container against the new dir. Possible follow-up if local fork testing becomes necessary.
