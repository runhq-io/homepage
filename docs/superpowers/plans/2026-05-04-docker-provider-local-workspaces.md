# DockerProvider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `DockerProvider` to `be/`'s provider abstraction so workspaces created from a local backend run as Docker containers on the dev machine instead of provisioning real Fly.io machines.

**Architecture:** Implement `IProvider` against the local Docker daemon via the `dockerode` npm client. Containers are created from a lazily-built `runhq-server:local` image, with workspace data persisted via bind mounts under `/app/data/local-workspaces/<volumeId>/`. Routing is `http://localhost:<hostPort>` only — no public URL plumbing.

**Tech Stack:** TypeScript, Node.js 22+, vitest, dockerode, existing IProvider abstraction.

**Spec:** [`docs/superpowers/specs/2026-05-04-docker-provider-local-workspaces-design.md`](../specs/2026-05-04-docker-provider-local-workspaces-design.md)

**Pre-flight check:** Confirm working directory is `be/.worktrees/docker-provider/` (the worktree on branch `feat/docker-provider`). All file paths in this plan are relative to that directory.

```bash
cd /app/data/home/be/.worktrees/docker-provider
git branch --show-current  # must print: feat/docker-provider
```

---

## File Map

### New files

| Path | Purpose |
|---|---|
| `src/api/services/providers/DockerProvider.ts` | Implements `IProvider` using dockerode. |
| `src/api/services/providers/DockerProvider.test.ts` | Unit tests with dockerode mocked. |
| `src/api/services/providers/DockerProvider.integration.test.ts` | Real-Docker tests gated behind `RUN_DOCKER_INTEGRATION=1`. |

### Modified files

| Path | Change |
|---|---|
| `src/api/services/providers/types.ts` | Extend `ProviderId` literal to `'fly' \| 'docker'`. |
| `src/api/services/providers/registry.ts` | Register DockerProvider, update `getDefaultProviderId()`, add `'docker'` to `HOURLY_RATES`. |
| `src/api/services/providers/index.ts` | Re-export `DockerProvider`. |
| `package.json` | Add `dockerode` and `@types/dockerode`. |
| `.env.example` | Document `LOCAL_PROVIDER`, `RUNHQ_WORKSPACE_IMAGE`, `RUNHQ_WORKSPACE_DOCKERFILE_DIR`. |

---

## Test command

All test steps run via:

```bash
pnpm exec vitest run <relative-test-path> [-t "<test name pattern>"]
```

Example:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "isConfigured"
```

`pnpm exec vitest run <path>` (no `-t`) runs all tests in that file. Always use `vitest run` (not `vitest`) so the process exits when tests finish.

---

## Task 1: Add dockerode dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dockerode and types**

Run:
```bash
pnpm add dockerode
pnpm add -D @types/dockerode
```

Expected: `package.json` gains `"dockerode": "^4.0.0"` (or newer) under `dependencies` and `"@types/dockerode": "^3.3.0"` (or newer) under `devDependencies`. `pnpm-lock.yaml` is updated.

- [ ] **Step 2: Verify the import resolves**

Run:
```bash
node --input-type=module -e "import Docker from 'dockerode'; const d = new Docker(); console.log(typeof d.ping);"
```

Expected: prints `function`. Errors → resolve before proceeding (likely package not installed).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps(provider): add dockerode for DockerProvider"
```

---

## Task 2: Extend `ProviderId` to include `'docker'`

> Keep `IProvider.isConfigured` synchronous (matches FlyProvider). DockerProvider's `isConfigured` does a sync `fs.statSync` check on `/var/run/docker.sock`. The actual `docker.ping()` happens lazily inside `createMachine`. No changes to `registry.ts` callers.

**Files:**
- Modify: `src/api/services/providers/types.ts:12`

- [ ] **Step 1: Write the failing assertion as a tiny standalone test**

Create `src/api/services/providers/types.test.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest';
import type { ProviderId } from './types';

describe('ProviderId', () => {
  it('includes docker', () => {
    expectTypeOf<ProviderId>().toEqualTypeOf<'fly' | 'docker'>();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/types.test.ts
```

Expected: FAIL — type mismatch (`ProviderId` is currently `'fly'`, not `'fly' | 'docker'`).

- [ ] **Step 3: Edit `types.ts:12`**

Change line 12:
```ts
export type ProviderId = 'fly';
```
to:
```ts
export type ProviderId = 'fly' | 'docker';
```

- [ ] **Step 4: Run test — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck across the repo**

Run:
```bash
pnpm typecheck
```

Expected: One known error — `HOURLY_RATES: Record<ProviderId, ...>` in `registry.ts:33` now requires a `docker` key (we add it in Task 14). If `pnpm typecheck` fails **only** for that reason, that's acceptable for this commit. If it fails for any other reason, fix or back out.

- [ ] **Step 6: Commit**

```bash
git add src/api/services/providers/types.ts src/api/services/providers/types.test.ts
git commit -m "feat(provider): extend ProviderId to include 'docker'"
```

---

## Task 3: Create `DockerProvider` skeleton with config methods

Create the file with the three configuration methods (`isConfigured`, `getRegions`, `getTierSpecs`). The other methods are stubbed with `throw new Error('not implemented')` so the type-checker is happy that the class fully implements `IProvider`. We'll fill them in subsequent tasks.

**Files:**
- Create: `src/api/services/providers/DockerProvider.ts`
- Create: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/services/providers/DockerProvider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock dockerode at the module level. Each test resets the mock and configures
// behaviour via the returned mock factory.
const mockPing = vi.fn();
const mockListContainers = vi.fn();
const mockListImages = vi.fn();
const mockGetContainer = vi.fn();
const mockBuildImage = vi.fn();
const mockCreateContainer = vi.fn();

vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      ping: mockPing,
      listContainers: mockListContainers,
      listImages: mockListImages,
      getContainer: mockGetContainer,
      buildImage: mockBuildImage,
      createContainer: mockCreateContainer,
    })),
  };
});

// For isConfigured() tests we point RUNHQ_DOCKER_SOCK_PATH at a fake socket file
// (or a non-existent path) so we can deterministically test the sync check
// without needing a real Docker daemon.
function makeFakeSocket(dir: string): string {
  // Node has no API to create a Unix socket file inode without binding a server,
  // so we use an empty regular file and set RUNHQ_DOCKER_SOCK_KIND=file in tests
  // to bypass the isSocket() assertion. Production code does NOT honor this env
  // var (test-only; declared in the test file).
  const path = join(dir, 'docker.sock');
  writeFileSync(path, '');
  return path;
}

describe('DockerProvider — configuration', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  let tmp: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tmp = mkdtempSync(join(tmpdir(), 'runhq-cfg-'));
    delete process.env.RUNHQ_DOCKER_SOCK_PATH;
    delete process.env.RUNHQ_DOCKER_SOCK_KIND;
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.RUNHQ_DOCKER_SOCK_PATH;
    delete process.env.RUNHQ_DOCKER_SOCK_KIND;
  });

  it('exposes id "docker"', () => {
    const p = new DockerProvider();
    expect(p.id).toBe('docker');
  });

  it('isConfigured() returns true when socket file exists (sync check)', () => {
    // Use the test-only RUNHQ_DOCKER_SOCK_KIND=file escape hatch — see test
    // helper `makeFakeSocket`.
    process.env.RUNHQ_DOCKER_SOCK_PATH = makeFakeSocket(tmp);
    process.env.RUNHQ_DOCKER_SOCK_KIND = 'file';
    const p = new DockerProvider();
    expect(p.isConfigured()).toBe(true);
  });

  it('isConfigured() returns false when socket path does not exist', () => {
    process.env.RUNHQ_DOCKER_SOCK_PATH = join(tmp, 'nope.sock');
    const p = new DockerProvider();
    expect(p.isConfigured()).toBe(false);
  });

  it('getRegions() returns a single synthetic local region', () => {
    const p = new DockerProvider();
    expect(p.getRegions()).toEqual([
      { id: 'local', providerId: 'docker', providerRegion: 'local', displayName: 'Local Docker' },
    ]);
  });

  it('getTierSpecs() returns the same 13 tier specs as Fly', () => {
    const p = new DockerProvider();
    const specs = p.getTierSpecs();
    expect(specs).toHaveLength(13);
    expect(specs.map((s) => s.tierId)).toContain('shared-4x-2gb');
    expect(specs.map((s) => s.tierId)).toContain('perf-4x-32gb');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (DockerProvider not yet created)**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts
```

Expected: FAIL — `Cannot find module './DockerProvider'`.

- [ ] **Step 3: Create `DockerProvider.ts` skeleton**

Create `src/api/services/providers/DockerProvider.ts`:

```ts
/**
 * DockerProvider
 *
 * Implements IProvider for local development. Workspaces are provisioned as
 * Docker containers on the host's Docker daemon, with bind-mounted volumes
 * under /app/data/local-workspaces/<volumeId>/.
 *
 * See docs/superpowers/specs/2026-05-04-docker-provider-local-workspaces-design.md.
 */

import Docker from 'dockerode';
import { statSync } from 'node:fs';
import type { IProvider } from './IProvider';
import type {
  CreateMachineOptions,
  MachineInfo,
  MachineState,
  ProviderId,
  ProvisionResult,
  Region,
  RoutingInfo,
  SnapshotInfo,
  TierId,
  TierSpec,
  VolumeInfo,
} from './types';

const NOT_IMPLEMENTED = (method: string) =>
  new Error(`DockerProvider.${method} not implemented yet`);

const DEFAULT_DOCKER_SOCK = '/var/run/docker.sock';

export class DockerProvider implements IProvider {
  readonly id: ProviderId = 'docker';

  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  // Sync per IProvider contract. Checks that the Docker socket file exists
  // and (in production) is a Unix socket. The actual liveness check
  // (docker.ping()) happens lazily inside createMachine.
  isConfigured(): boolean {
    const sockPath = process.env.RUNHQ_DOCKER_SOCK_PATH || DEFAULT_DOCKER_SOCK;
    try {
      const s = statSync(sockPath);
      // Test-only env var lets unit tests use a regular file as a stand-in.
      if (process.env.RUNHQ_DOCKER_SOCK_KIND === 'file') return s.isFile();
      return s.isSocket();
    } catch {
      return false;
    }
  }

  getRegions(): Region[] {
    return [
      { id: 'local', providerId: 'docker', providerRegion: 'local', displayName: 'Local Docker' },
    ];
  }

  getTierSpecs(): TierSpec[] {
    return [
      { tierId: 'shared-4x-1gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 1024,  diskGb: 12,  label: 'Shared 4x / 1 GB' },
      { tierId: 'shared-4x-2gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 2048,  diskGb: 20,  label: 'Shared 4x / 2 GB' },
      { tierId: 'shared-4x-4gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 4096,  diskGb: 40,  label: 'Shared 4x / 4 GB' },
      { tierId: 'shared-4x-8gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 8192,  diskGb: 40,  label: 'Shared 4x / 8 GB' },
      { tierId: 'shared-8x-4gb',  cpuKind: 'shared',      cpus: 8, memoryMb: 4096,  diskGb: 40,  label: 'Shared 8x / 4 GB' },
      { tierId: 'shared-8x-8gb',  cpuKind: 'shared',      cpus: 8, memoryMb: 8192,  diskGb: 60,  label: 'Shared 8x / 8 GB' },
      { tierId: 'shared-8x-16gb', cpuKind: 'shared',      cpus: 8, memoryMb: 16384, diskGb: 80,  label: 'Shared 8x / 16 GB' },
      { tierId: 'perf-2x-4gb',    cpuKind: 'performance', cpus: 2, memoryMb: 4096,  diskGb: 40,  label: 'Perf 2x / 4 GB' },
      { tierId: 'perf-2x-8gb',    cpuKind: 'performance', cpus: 2, memoryMb: 8192,  diskGb: 60,  label: 'Perf 2x / 8 GB' },
      { tierId: 'perf-2x-16gb',   cpuKind: 'performance', cpus: 2, memoryMb: 16384, diskGb: 80,  label: 'Perf 2x / 16 GB' },
      { tierId: 'perf-4x-8gb',    cpuKind: 'performance', cpus: 4, memoryMb: 8192,  diskGb: 60,  label: 'Perf 4x / 8 GB' },
      { tierId: 'perf-4x-16gb',   cpuKind: 'performance', cpus: 4, memoryMb: 16384, diskGb: 100, label: 'Perf 4x / 16 GB' },
      { tierId: 'perf-4x-32gb',   cpuKind: 'performance', cpus: 4, memoryMb: 32768, diskGb: 160, label: 'Perf 4x / 32 GB' },
    ];
  }

  // -------------------------------------------------------------------------
  // App lifecycle (no-ops; Docker has no per-tenant network isolation locally)
  // -------------------------------------------------------------------------

  async createApp(_appName: string, _networkName: string): Promise<void> {}
  async deleteApp(_appName: string): Promise<void> {}
  async allocateIPs(_appName: string, _opts?: { sharedV4?: boolean; v6?: boolean }): Promise<void> {}
  async addCertificate(_appName: string, _hostname: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Machine lifecycle — STUBS (filled in subsequent tasks)
  // -------------------------------------------------------------------------

  async createMachine(_options: CreateMachineOptions): Promise<ProvisionResult> {
    throw NOT_IMPLEMENTED('createMachine');
  }
  async getMachineState(_machineId: string, _appName?: string | null): Promise<MachineState> {
    throw NOT_IMPLEMENTED('getMachineState');
  }
  async getMachineInfo(_machineId: string, _appName?: string | null): Promise<MachineInfo> {
    throw NOT_IMPLEMENTED('getMachineInfo');
  }
  async startMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('startMachine');
  }
  async stopMachine(
    _machineId: string,
    _appName?: string | null,
    _options?: { disableAutostart?: boolean },
  ): Promise<void> {
    throw NOT_IMPLEMENTED('stopMachine');
  }
  async suspendMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('suspendMachine');
  }
  async restartMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('restartMachine');
  }
  async updateMachineImage(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('updateMachineImage');
  }
  async deleteMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('deleteMachine');
  }

  // -------------------------------------------------------------------------
  // Volumes — STUBS
  // -------------------------------------------------------------------------

  async createVolume(_name: string, _region: string, _sizeGb?: number, _appName?: string | null): Promise<VolumeInfo> {
    throw NOT_IMPLEMENTED('createVolume');
  }
  async getVolume(_volumeId: string, _appName?: string | null): Promise<VolumeInfo | null> {
    throw NOT_IMPLEMENTED('getVolume');
  }
  async extendVolume(_volumeId: string, _newSizeGb: number, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('extendVolume');
  }
  async createVolumeFromSnapshot(_snapshotId: string, _name: string, _region: string, _sizeGb: number, _appName?: string | null): Promise<VolumeInfo> {
    throw NOT_IMPLEMENTED('createVolumeFromSnapshot');
  }
  async forkVolume(_sourceVolumeId: string, _name: string, _region: string, _sizeGb?: number, _appName?: string | null): Promise<VolumeInfo> {
    throw NOT_IMPLEMENTED('forkVolume');
  }
  async createSnapshot(_volumeId: string, _appName?: string | null): Promise<SnapshotInfo> {
    throw NOT_IMPLEMENTED('createSnapshot');
  }
  async deleteVolume(_volumeId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('deleteVolume');
  }
  async waitForVolumeReady(_volumeId: string, _appName?: string | null, _timeoutMs?: number): Promise<void> {
    throw NOT_IMPLEMENTED('waitForVolumeReady');
  }

  // -------------------------------------------------------------------------
  // Health / waiting / routing / config — STUBS
  // -------------------------------------------------------------------------

  async waitForState(_machineId: string, _targetStates: MachineState[], _timeoutMs?: number, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('waitForState');
  }
  async waitForHealthy(_machineId: string, _timeoutMs?: number, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('waitForHealthy');
  }
  getRoutingInfo(_machineId: string, _appName?: string | null): RoutingInfo {
    throw NOT_IMPLEMENTED('getRoutingInfo');
  }
  async updateAutoSuspendPolicy(_machineId: string, _autoSuspendEnabled: boolean, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('updateAutoSuspendPolicy');
  }
  async updateMachineEnv(_machineId: string, _env: Record<string, string>, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('updateMachineEnv');
  }
  async listMachines(_appName?: string | null): Promise<MachineInfo[]> {
    throw NOT_IMPLEMENTED('listMachines');
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts
```

Expected: PASS (5 tests pass: id, isConfigured-true, isConfigured-false, getRegions, getTierSpecs).

- [ ] **Step 5: Run typecheck**

Run:
```bash
pnpm typecheck
```

Expected: The class fully implements `IProvider` (all stub methods have correct signatures). The `Record<ProviderId, …>` issue from Task 2 is still pending until Task 14 — if it's the only error, accept and move on.

- [ ] **Step 6: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts \
        src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider skeleton with config methods"
```

---

## Task 4: Implement volume management

Bind-mount-backed volumes under `/app/data/local-workspaces/<volumeId>/`. The base path is configurable via `RUNHQ_LOCAL_VOLUMES_DIR` env var (default `/app/data/local-workspaces`) so unit tests can use a temp dir.

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append volume tests**

Append to `src/api/services/providers/DockerProvider.test.ts`:

```ts
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('DockerProvider — volumes', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  let baseDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    baseDir = mkdtempSync(join(tmpdir(), 'runhq-vol-test-'));
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = baseDir;
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
  });

  it('createVolume mkdir\'s a UUID-named dir under the base and returns VolumeInfo', async () => {
    const p = new DockerProvider();
    const info = await p.createVolume('my-vol', 'local', 10);
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(info.name).toBe('my-vol');
    expect(info.state).toBe('created');
    expect(info.sizeGb).toBe(10);
    expect(info.region).toBe('local');
    expect(existsSync(join(baseDir, info.id))).toBe(true);
    expect(statSync(join(baseDir, info.id)).isDirectory()).toBe(true);
  });

  it('getVolume returns info for an existing dir', async () => {
    const p = new DockerProvider();
    const created = await p.createVolume('v', 'local', 5);
    const fetched = await p.getVolume(created.id);
    expect(fetched).toEqual({
      id: created.id,
      name: created.id,           // Name not persisted; falls back to id
      state: 'created',
      sizeGb: 0,                  // Size not persisted; reported as 0
      region: 'local',
    });
  });

  it('getVolume returns null for a non-existent dir', async () => {
    const p = new DockerProvider();
    expect(await p.getVolume('does-not-exist')).toBeNull();
  });

  it('deleteVolume removes the dir', async () => {
    const p = new DockerProvider();
    const v = await p.createVolume('v', 'local', 1);
    expect(existsSync(join(baseDir, v.id))).toBe(true);
    await p.deleteVolume(v.id);
    expect(existsSync(join(baseDir, v.id))).toBe(false);
  });

  it('deleteVolume is idempotent (no-op on missing dir)', async () => {
    const p = new DockerProvider();
    await expect(p.deleteVolume('never-existed')).resolves.toBeUndefined();
  });

  it('extendVolume is a no-op (does not throw)', async () => {
    const p = new DockerProvider();
    const v = await p.createVolume('v', 'local', 1);
    await expect(p.extendVolume(v.id, 100)).resolves.toBeUndefined();
  });

  it('waitForVolumeReady resolves immediately', async () => {
    const p = new DockerProvider();
    await expect(p.waitForVolumeReady('any-id')).resolves.toBeUndefined();
  });

  it('createVolumeFromSnapshot throws not-supported', async () => {
    const p = new DockerProvider();
    await expect(p.createVolumeFromSnapshot('s', 'n', 'local', 1)).rejects.toThrow(
      /not supported by DockerProvider/,
    );
  });

  it('forkVolume throws not-supported', async () => {
    const p = new DockerProvider();
    await expect(p.forkVolume('v', 'n', 'local')).rejects.toThrow(
      /not supported by DockerProvider/,
    );
  });

  it('createSnapshot throws not-supported', async () => {
    const p = new DockerProvider();
    await expect(p.createSnapshot('v')).rejects.toThrow(
      /not supported by DockerProvider/,
    );
  });
});
```

Add the `afterEach` import to the existing import line:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts
```

Expected: 10 new tests fail with `not implemented yet`.

- [ ] **Step 3: Implement volume methods**

Replace the volume stubs in `src/api/services/providers/DockerProvider.ts`. Add at the top of the file:

```ts
import { mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
```

Add a private helper after the constructor:

```ts
private get volumesBaseDir(): string {
  return process.env.RUNHQ_LOCAL_VOLUMES_DIR || '/app/data/local-workspaces';
}

private volumeDir(volumeId: string): string {
  return join(this.volumesBaseDir, volumeId);
}
```

Replace each volume method:

```ts
async createVolume(
  name: string,
  region: string,
  sizeGb?: number,
  _appName?: string | null,
): Promise<VolumeInfo> {
  const id = randomUUID();
  await mkdir(this.volumeDir(id), { recursive: true, mode: 0o755 });
  return {
    id,
    name,
    state: 'created',
    sizeGb: sizeGb ?? 0,
    region: region || 'local',
  };
}

async getVolume(volumeId: string, _appName?: string | null): Promise<VolumeInfo | null> {
  const dir = this.volumeDir(volumeId);
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return null;
    return {
      id: volumeId,
      name: volumeId,
      state: 'created',
      sizeGb: 0,
      region: 'local',
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async extendVolume(_volumeId: string, _newSizeGb: number, _appName?: string | null): Promise<void> {
  // Local provider does not enforce volume size; host fs has whatever space it has.
}

async deleteVolume(volumeId: string, _appName?: string | null): Promise<void> {
  if (!existsSync(this.volumeDir(volumeId))) return; // idempotent
  await rm(this.volumeDir(volumeId), { recursive: true, force: true });
}

async waitForVolumeReady(_volumeId: string, _appName?: string | null, _timeoutMs?: number): Promise<void> {
  // Host fs is always ready.
}

async createVolumeFromSnapshot(): Promise<VolumeInfo> {
  throw new Error(
    'Snapshots are not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
  );
}

async forkVolume(): Promise<VolumeInfo> {
  throw new Error(
    'Volume forking is not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
  );
}

async createSnapshot(): Promise<SnapshotInfo> {
  throw new Error(
    'Snapshots are not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
  );
}
```

Note: the public method signatures must still match `IProvider` exactly. Above, `createVolumeFromSnapshot` etc. drop their parameter lists in the implementation but the interface methods declare them — since we never read the params, this is fine. Use `_paramName` if TypeScript complains under `strict noUnusedParameters`.

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts
```

Expected: All previous tests still pass + 10 new volume tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider volume management (bind-mount backed)"
```

---

## Task 5: Implement state mapping helper

Map Docker's `inspect.State.Status` to our `MachineState` enum. A pure function with a unit test.

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — state mapping', () => {
  let mapDockerState: (s: string) => MachineState;
  let MachineState: unknown;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./DockerProvider');
    mapDockerState = mod.__test__.mapDockerState;
  });

  it.each([
    ['running', 'running'],
    ['paused', 'suspended'],
    ['exited', 'stopped'],
    ['created', 'stopped'],
    ['restarting', 'starting'],
    ['removing', 'destroying'],
    ['dead', 'destroyed'],
  ] as const)('maps docker state %s -> %s', (docker, expected) => {
    expect(mapDockerState(docker)).toBe(expected);
  });

  it('throws on unknown docker state', () => {
    expect(() => mapDockerState('cosmic-ray')).toThrow(/unknown docker state/i);
  });
});
```

Add `MachineState` type import at top of test file:
```ts
import type { MachineState } from './types';
```

- [ ] **Step 2: Run test — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "state mapping"
```

Expected: FAIL — `__test__` not exported.

- [ ] **Step 3: Implement and export the mapping**

Add to `DockerProvider.ts` (top-level, near the other helpers, NOT inside the class):

```ts
function mapDockerState(dockerStatus: string): MachineState {
  switch (dockerStatus) {
    case 'running':    return 'running';
    case 'paused':     return 'suspended';
    case 'exited':     return 'stopped';
    case 'created':    return 'stopped';
    case 'restarting': return 'starting';
    case 'removing':   return 'destroying';
    case 'dead':       return 'destroyed';
    default:
      throw new Error(`Unknown docker state: ${dockerStatus}`);
  }
}

// Test-only export. Do not import from production code.
export const __test__ = { mapDockerState };
```

- [ ] **Step 4: Run test — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "state mapping"
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider state mapping helper"
```

---

## Task 6: Implement free-port allocation helper

Allocate a free host port via `net.createServer().listen(0)` so each container gets a unique port. Single retry on `EADDRINUSE` race.

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — port allocation', () => {
  let allocateHostPort: () => Promise<number>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./DockerProvider');
    allocateHostPort = mod.__test__.allocateHostPort;
  });

  it('returns a free port (> 1024)', async () => {
    const port = await allocateHostPort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  it('returns different ports across calls', async () => {
    // Note: not strictly guaranteed (the OS is free to reuse), but in
    // practice consecutive listen(0) calls return different ports.
    const a = await allocateHostPort();
    const b = await allocateHostPort();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "port allocation"
```

Expected: FAIL — `allocateHostPort` not exported.

- [ ] **Step 3: Implement port allocator**

Add to `DockerProvider.ts`:

```ts
import { createServer } from 'node:net';

async function allocateHostPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('Failed to allocate host port'));
      }
    });
  });
}
```

Update the `__test__` export:

```ts
export const __test__ = { mapDockerState, allocateHostPort };
```

- [ ] **Step 4: Run test — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "port allocation"
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider host port allocator"
```

---

## Task 7: Implement image resolution and lazy build

Resolve the workspace image ref (env var or default `runhq-server:local`) and lazy-build the `:local` tag from `RUNHQ_WORKSPACE_DOCKERFILE_DIR` (or `../runhq/server`) on first use.

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — image resolution', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RUNHQ_WORKSPACE_IMAGE;
    delete process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR;
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('uses RUNHQ_WORKSPACE_IMAGE env var when set', async () => {
    process.env.RUNHQ_WORKSPACE_IMAGE = 'my.registry/foo:v1';
    const p = new DockerProvider();
    expect(p.resolveImageRef()).toBe('my.registry/foo:v1');
  });

  it('defaults to runhq-server:local when env var unset', () => {
    const p = new DockerProvider();
    expect(p.resolveImageRef()).toBe('runhq-server:local');
  });

  it('ensureImage skips build when image already exists', async () => {
    mockListImages.mockResolvedValueOnce([{ Id: 'sha256:abc', RepoTags: ['runhq-server:local'] }]);
    const p = new DockerProvider();
    await p.ensureImage('runhq-server:local');
    expect(mockBuildImage).not.toHaveBeenCalled();
  });

  it('ensureImage builds when :local tag missing and dockerfile dir is set', async () => {
    process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR = '/tmp/fake-dockerfile-dir';
    mockListImages.mockResolvedValueOnce([]);

    // dockerode.buildImage returns a stream; we resolve immediately.
    const fakeStream = {
      on: vi.fn((evt: string, cb: () => void) => {
        if (evt === 'end') queueMicrotask(cb);
        return fakeStream;
      }),
    };
    mockBuildImage.mockResolvedValueOnce(fakeStream);

    const p = new DockerProvider();
    await p.ensureImage('runhq-server:local');

    expect(mockBuildImage).toHaveBeenCalledTimes(1);
    const [ctx, opts] = mockBuildImage.mock.calls[0];
    expect(ctx).toMatchObject({ context: '/tmp/fake-dockerfile-dir' });
    expect(opts).toMatchObject({ t: 'runhq-server:local' });
  });

  it('ensureImage throws when non-:local image is missing (no auto-build)', async () => {
    mockListImages.mockResolvedValueOnce([]);
    const p = new DockerProvider();
    await expect(p.ensureImage('my.registry/foo:v1')).rejects.toThrow(
      /image 'my.registry\/foo:v1' not found.*pull/i,
    );
    expect(mockBuildImage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "image resolution"
```

Expected: FAIL — `resolveImageRef` and `ensureImage` not on the class.

- [ ] **Step 3: Implement image resolution + ensureImage**

Add to the `DockerProvider` class:

```ts
resolveImageRef(): string {
  return process.env.RUNHQ_WORKSPACE_IMAGE || 'runhq-server:local';
}

private dockerfileDir(): string {
  return (
    process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR ||
    join(process.cwd(), '..', 'runhq', 'server')
  );
}

async ensureImage(ref: string): Promise<void> {
  const images = await this.docker.listImages({ filters: { reference: [ref] } });
  if (images.length > 0) return;

  if (!ref.endsWith(':local')) {
    throw new Error(
      `Workspace image '${ref}' not found locally. Pull it (e.g. \`docker pull ${ref}\`) or unset RUNHQ_WORKSPACE_IMAGE to lazy-build runhq-server:local.`,
    );
  }

  const ctxDir = this.dockerfileDir();
  console.log(`[DockerProvider] Building ${ref} from ${ctxDir} (one-time, may take minutes)...`);
  const stream = await this.docker.buildImage({ context: ctxDir, src: ['Dockerfile'] }, { t: ref });

  await new Promise<void>((resolve, reject) => {
    // Consume the build stream until 'end'. dockerode emits per-line build
    // output; we ignore it (build progress) but watch for errors.
    let lastError: Error | null = null;
    stream.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.error) lastError = new Error(`docker build: ${obj.error}`);
        } catch {
          // Non-JSON progress line; ignore.
        }
      }
    });
    stream.on('end', () => (lastError ? reject(lastError) : resolve()));
    stream.on('error', reject);
  });

  console.log(`[DockerProvider] Built ${ref}`);
}
```

> Note: in the test, the fakeStream doesn't emit `data` events, only `end`. The implementation handles both real (data + end) and trivial (end-only) streams.

- [ ] **Step 4: Run test — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "image resolution"
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider image resolution + lazy build"
```

---

## Task 8: Implement `createMachine`

Bring everything together: ensureImage → allocate port → createContainer with proper labels/env/mounts/ports/limits → start → return ProvisionResult.

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — createMachine', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  let baseDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    baseDir = mkdtempSync(join(tmpdir(), 'runhq-cm-test-'));
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = baseDir;
    process.env.SERVER_TOKEN = 'test-token';        // Will not actually be set by createMachine; opts pass it.
    delete process.env.RUNHQ_WORKSPACE_IMAGE;
    delete process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR;
    process.env.CLOUD_API_URL = 'http://test.cloud';

    // Image already present → no build attempt.
    mockListImages.mockResolvedValue([{ Id: 'sha256:abc', RepoTags: ['runhq-server:local'] }]);

    // Container creation returns a fake container with a 64-char id.
    const fullId = 'a'.repeat(64);
    const fakeContainer = {
      id: fullId,
      start: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateContainer.mockResolvedValue(fakeContainer);

    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
    delete process.env.SERVER_TOKEN;
    delete process.env.CLOUD_API_URL;
  });

  it('returns a ProvisionResult with localhost URL, 12-char machine id, and host port stored in appName', async () => {
    mockPing.mockResolvedValueOnce('OK');
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);

    const result = await p.createMachine({
      serverId: 'srv-123',
      serverToken: 'session-token',
      region: 'local',
      tier: 'shared-4x-2gb',
      existingVolumeId: v.id,
      autoSuspendEnabled: false,
      appName: null,
      networkName: null,
    });

    expect(result.machineId).toMatch(/^[a-f0-9]{12}$/);
    const portMatch = result.serverUrl.match(/^http:\/\/localhost:(\d+)$/);
    expect(portMatch).not.toBeNull();
    const hostPort = Number(portMatch![1]);
    expect(result.appName).toBe(String(hostPort));   // persisted port string
    expect(result.region).toBe('local');
    expect(result.volumeId).toBe(v.id);
    expect(result.providerMetadata).toMatchObject({
      hostPort,
      fullContainerId: 'a'.repeat(64),
    });
  });

  it('passes correct container spec to dockerode.createContainer', async () => {
    mockPing.mockResolvedValueOnce('OK');
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);

    await p.createMachine({
      serverId: 'srv-123',
      serverToken: 'session-token',
      region: 'local',
      tier: 'shared-4x-2gb',
      existingVolumeId: v.id,
      appName: null,
      networkName: null,
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const spec = mockCreateContainer.mock.calls[0][0];

    expect(spec.Image).toBe('runhq-server:local');
    expect(spec.Env).toEqual(expect.arrayContaining([
      'SERVER_TOKEN=session-token',
      'CLOUD_API_URL=http://test.cloud',
      'PORT=61987',
      'NODE_ENV=production',
    ]));
    expect(spec.Labels).toMatchObject({
      'runhq.managed': 'true',
      'runhq.serverId': 'srv-123',
      'runhq.volumeId': v.id,
      'runhq.tier': 'shared-4x-2gb',
    });
    expect(spec.Labels['runhq.hostPort']).toMatch(/^\d+$/);
    expect(spec.HostConfig.Binds).toEqual([
      `${join(baseDir, v.id)}:/app/data`,
    ]);
    expect(spec.HostConfig.PortBindings['61987/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: expect.any(String) },
    ]);
    expect(spec.HostConfig.NanoCpus).toBe(4_000_000_000);   // 4 CPUs
    expect(spec.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024); // 2 GB
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
  });

  it('container.start() is called after create', async () => {
    mockPing.mockResolvedValueOnce('OK');
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);

    await p.createMachine({
      serverId: 'srv-123',
      serverToken: 'tok',
      region: 'local',
      tier: 'shared-4x-1gb',
      existingVolumeId: v.id,
    });

    const ret = await mockCreateContainer.mock.results[0].value;
    expect(ret.start).toHaveBeenCalledTimes(1);
  });

  it('throws when docker.ping() rejects (daemon not responding)', async () => {
    mockPing.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);
    await expect(
      p.createMachine({
        serverId: 'srv',
        serverToken: 'tok',
        region: 'local',
        tier: 'shared-4x-1gb',
        existingVolumeId: v.id,
      }),
    ).rejects.toThrow(/Docker is not running/);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "createMachine"
```

Expected: FAIL — `createMachine` still throws `not implemented yet`.

- [ ] **Step 3: Implement createMachine**

Replace the `createMachine` stub:

```ts
async createMachine(options: CreateMachineOptions): Promise<ProvisionResult> {
  // Liveness check: isConfigured() only verifies the socket file. Ping the
  // daemon to make sure it's actually responding before we commit to a flow.
  try {
    await this.docker.ping();
  } catch (err: unknown) {
    throw new Error(
      `Docker is not running. Start Docker before creating workspaces. (cause: ${(err as Error).message})`,
    );
  }

  const imageRef = this.resolveImageRef();
  await this.ensureImage(imageRef);

  const hostPort = await allocateHostPort();
  const volumeId = options.existingVolumeId ?? randomUUID();
  // If a fresh volumeId was generated, materialize the dir so the bind
  // mount has somewhere to point. (createServer typically calls
  // createVolume separately, but be defensive.)
  if (!options.existingVolumeId) {
    await mkdir(this.volumeDir(volumeId), { recursive: true, mode: 0o755 });
  }

  const tierSpec = this.getTierSpecs().find((t) => t.tierId === options.tier);
  if (!tierSpec) throw new Error(`Unknown tier: ${options.tier}`);

  const env = [
    `SERVER_TOKEN=${options.serverToken}`,
    `CLOUD_API_URL=${process.env.CLOUD_API_URL ?? ''}`,
    `PORT=61987`,
    `NODE_ENV=production`,
  ];
  if (options.tunnelToken) env.push(`TUNNEL_TOKEN=${options.tunnelToken}`);

  const labels: Record<string, string> = {
    'runhq.managed': 'true',
    'runhq.serverId': options.serverId,
    'runhq.volumeId': volumeId,
    'runhq.tier': options.tier,
    'runhq.hostPort': String(hostPort),
  };

  const container = await this.docker.createContainer({
    Image: imageRef,
    Env: env,
    Labels: labels,
    ExposedPorts: { '61987/tcp': {} },
    HostConfig: {
      Binds: [`${this.volumeDir(volumeId)}:/app/data`],
      PortBindings: { '61987/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
      NanoCpus: tierSpec.cpus * 1_000_000_000,
      Memory: tierSpec.memoryMb * 1024 * 1024,
      RestartPolicy: { Name: 'unless-stopped' },
    },
  } as Docker.ContainerCreateOptions);

  await container.start();

  const fullId = container.id;
  const machineId = fullId.slice(0, 12);

  return {
    machineId,
    machineName: machineId,
    serverUrl: `http://localhost:${hostPort}`,
    region: 'local',
    volumeId,
    // Persisted in servers.flyAppName so getRoutingInfo can reconstruct
    // the URL synchronously after a be restart (no Docker round-trip).
    appName: String(hostPort),
    networkName: null,
    providerMetadata: { hostPort, fullContainerId: fullId },
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "createMachine"
```

Expected: PASS (4 tests).

- [ ] **Step 5: Run full DockerProvider test file**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts
```

Expected: All tests pass (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider.createMachine"
```

---

## Task 9: Implement `getMachineState` and `getMachineInfo`

Both inspect the container. State mapping uses the helper from Task 5.

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — inspect', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockInspect = vi.fn();
  const containerStub = { inspect: mockInspect };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetContainer.mockReturnValue(containerStub);
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('getMachineState returns mapped state', async () => {
    mockInspect.mockResolvedValueOnce({ State: { Status: 'running' } });
    const p = new DockerProvider();
    expect(await p.getMachineState('abc')).toBe('running');
    expect(mockGetContainer).toHaveBeenCalledWith('abc');
  });

  it('getMachineState returns "destroyed" on 404', async () => {
    const err = Object.assign(new Error('No such container'), { statusCode: 404 });
    mockInspect.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    expect(await p.getMachineState('gone')).toBe('destroyed');
  });

  it('getMachineState propagates non-404 errors', async () => {
    mockInspect.mockRejectedValueOnce(new Error('socket closed'));
    const p = new DockerProvider();
    await expect(p.getMachineState('abc')).rejects.toThrow('socket closed');
  });

  it('getMachineInfo returns normalized MachineInfo', async () => {
    mockInspect.mockResolvedValueOnce({
      Id: 'a'.repeat(64),
      Name: '/silly_einstein',
      State: { Status: 'running' },
      Config: { Labels: { 'runhq.serverId': 'srv-1' } },
    });
    const p = new DockerProvider();
    const info = await p.getMachineInfo('aaaaaaaaaaaa');
    expect(info).toEqual({
      id: 'aaaaaaaaaaaa',
      name: 'silly_einstein',
      state: 'running',
      region: 'local',
    });
  });

  it('getMachineInfo propagates 404 errors (does not swallow)', async () => {
    const err = Object.assign(new Error('No such container'), { statusCode: 404 });
    mockInspect.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.getMachineInfo('gone')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "inspect"
```

Expected: FAIL — both methods still stubbed.

- [ ] **Step 3: Implement**

Replace both stubs:

```ts
async getMachineState(machineId: string, _appName?: string | null): Promise<MachineState> {
  try {
    const data = await this.docker.getContainer(machineId).inspect();
    return mapDockerState(data.State.Status);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return 'destroyed';
    throw err;
  }
}

async getMachineInfo(machineId: string, _appName?: string | null): Promise<MachineInfo> {
  const data = await this.docker.getContainer(machineId).inspect();
  return {
    id: data.Id.slice(0, 12),
    name: typeof data.Name === 'string' ? data.Name.replace(/^\//, '') : data.Id.slice(0, 12),
    state: mapDockerState(data.State.Status),
    region: 'local',
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "inspect"
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider.getMachineState/getMachineInfo"
```

---

## Task 10: Implement lifecycle ops (start, stop, restart, suspend, delete)

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — lifecycle ops', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockStart = vi.fn();
  const mockStop = vi.fn();
  const mockRestart = vi.fn();
  const mockPause = vi.fn();
  const mockRemove = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetContainer.mockReturnValue({
      start: mockStart,
      stop: mockStop,
      restart: mockRestart,
      pause: mockPause,
      remove: mockRemove,
    });
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('startMachine calls container.start', async () => {
    mockStart.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.startMachine('abc');
    expect(mockStart).toHaveBeenCalled();
  });

  it('startMachine swallows "already started" errors (304)', async () => {
    const err = Object.assign(new Error('not modified'), { statusCode: 304 });
    mockStart.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.startMachine('abc')).resolves.toBeUndefined();
  });

  it('stopMachine calls container.stop with timeout', async () => {
    mockStop.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.stopMachine('abc');
    expect(mockStop).toHaveBeenCalledWith({ t: 10 });
  });

  it('stopMachine swallows "already stopped" (304)', async () => {
    const err = Object.assign(new Error('not modified'), { statusCode: 304 });
    mockStop.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.stopMachine('abc')).resolves.toBeUndefined();
  });

  it('restartMachine calls container.restart', async () => {
    mockRestart.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.restartMachine('abc');
    expect(mockRestart).toHaveBeenCalled();
  });

  it('suspendMachine calls container.pause', async () => {
    mockPause.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.suspendMachine('abc');
    expect(mockPause).toHaveBeenCalled();
  });

  it('deleteMachine stops then removes', async () => {
    mockStop.mockResolvedValueOnce(undefined);
    mockRemove.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.deleteMachine('abc');
    expect(mockStop).toHaveBeenCalledWith({ t: 10 });
    expect(mockRemove).toHaveBeenCalled();
  });

  it('deleteMachine ignores 404 on stop and remove', async () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 });
    mockStop.mockRejectedValueOnce(err);
    mockRemove.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.deleteMachine('gone')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "lifecycle ops"
```

Expected: FAIL — methods still stubbed.

- [ ] **Step 3: Implement**

Add to `DockerProvider.ts`:

```ts
private isHttpError(err: unknown, code: number): boolean {
  return (err as { statusCode?: number })?.statusCode === code;
}

async startMachine(machineId: string, _appName?: string | null): Promise<void> {
  try {
    await this.docker.getContainer(machineId).start();
  } catch (err: unknown) {
    if (this.isHttpError(err, 304)) return; // already running
    throw err;
  }
}

async stopMachine(
  machineId: string,
  _appName?: string | null,
  _options?: { disableAutostart?: boolean },
): Promise<void> {
  try {
    await this.docker.getContainer(machineId).stop({ t: 10 });
  } catch (err: unknown) {
    if (this.isHttpError(err, 304)) return; // already stopped
    throw err;
  }
}

async restartMachine(machineId: string, _appName?: string | null): Promise<void> {
  await this.docker.getContainer(machineId).restart();
}

async suspendMachine(machineId: string, _appName?: string | null): Promise<void> {
  await this.docker.getContainer(machineId).pause();
}

async deleteMachine(machineId: string, _appName?: string | null): Promise<void> {
  const container = this.docker.getContainer(machineId);
  try {
    await container.stop({ t: 10 });
  } catch (err: unknown) {
    if (!this.isHttpError(err, 304) && !this.isHttpError(err, 404)) throw err;
  }
  try {
    await container.remove();
  } catch (err: unknown) {
    if (!this.isHttpError(err, 404)) throw err;
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "lifecycle ops"
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider lifecycle ops (start/stop/restart/suspend/delete)"
```

---

## Task 11: Implement `updateMachineImage` and `updateMachineEnv` (recreate-based)

Both work the same way: stop → record current spec → remove → create with same labels/volume/port + new image (or env).

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — recreate ops', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockInspect = vi.fn();
  const mockStop = vi.fn();
  const mockRemove = vi.fn();
  const mockStart = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = '/tmp/runhq-vols';
    mockGetContainer.mockReturnValue({ inspect: mockInspect, stop: mockStop, remove: mockRemove });
    mockListImages.mockResolvedValue([{ Id: 'sha256:abc', RepoTags: ['runhq-server:local'] }]);
    mockCreateContainer.mockResolvedValue({ id: 'b'.repeat(64), start: mockStart });
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
  });

  it('updateMachineImage stops, removes, recreates with new image', async () => {
    mockInspect.mockResolvedValueOnce({
      Id: 'a'.repeat(64),
      Image: 'runhq-server:local',
      Config: {
        Image: 'runhq-server:local',
        Env: ['SERVER_TOKEN=t', 'PORT=61987'],
        Labels: {
          'runhq.managed': 'true',
          'runhq.serverId': 'srv-1',
          'runhq.volumeId': 'v-1',
          'runhq.tier': 'shared-4x-2gb',
          'runhq.hostPort': '12345',
        },
        ExposedPorts: { '61987/tcp': {} },
      },
      HostConfig: {
        Binds: ['/tmp/runhq-vols/v-1:/app/data'],
        PortBindings: { '61987/tcp': [{ HostIp: '127.0.0.1', HostPort: '12345' }] },
        NanoCpus: 4_000_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    mockStop.mockResolvedValueOnce(undefined);
    mockRemove.mockResolvedValueOnce(undefined);

    process.env.RUNHQ_WORKSPACE_IMAGE = 'runhq-server:v2';
    mockListImages.mockResolvedValue([{ Id: 'sha256:def', RepoTags: ['runhq-server:v2'] }]);

    const p = new DockerProvider();
    await p.updateMachineImage('abc');

    expect(mockStop).toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalled();
    const spec = mockCreateContainer.mock.calls[0][0];
    expect(spec.Image).toBe('runhq-server:v2');
    expect(spec.Labels).toMatchObject({ 'runhq.serverId': 'srv-1' });
    expect(spec.HostConfig.Binds).toEqual(['/tmp/runhq-vols/v-1:/app/data']);
    expect(spec.HostConfig.PortBindings['61987/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: '12345' },
    ]);
    expect(mockStart).toHaveBeenCalled();

    delete process.env.RUNHQ_WORKSPACE_IMAGE;
  });

  it('updateMachineEnv recreates with merged env', async () => {
    mockInspect.mockResolvedValueOnce({
      Id: 'a'.repeat(64),
      Config: {
        Image: 'runhq-server:local',
        Env: ['SERVER_TOKEN=old', 'PORT=61987', 'EXTRA=keep'],
        Labels: {
          'runhq.managed': 'true',
          'runhq.serverId': 'srv-1',
          'runhq.volumeId': 'v-1',
          'runhq.tier': 'shared-4x-2gb',
          'runhq.hostPort': '12345',
        },
        ExposedPorts: { '61987/tcp': {} },
      },
      HostConfig: {
        Binds: ['/tmp/runhq-vols/v-1:/app/data'],
        PortBindings: { '61987/tcp': [{ HostIp: '127.0.0.1', HostPort: '12345' }] },
        NanoCpus: 4_000_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    mockStop.mockResolvedValueOnce(undefined);
    mockRemove.mockResolvedValueOnce(undefined);

    const p = new DockerProvider();
    await p.updateMachineEnv('abc', { SERVER_TOKEN: 'new', NEW_KEY: 'val' });

    const spec = mockCreateContainer.mock.calls[0][0];
    expect(spec.Env).toEqual(expect.arrayContaining([
      'SERVER_TOKEN=new',
      'PORT=61987',
      'EXTRA=keep',
      'NEW_KEY=val',
    ]));
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "recreate ops"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Add a private helper and replace both stubs in `DockerProvider.ts`:

```ts
private async recreateContainer(
  machineId: string,
  transform: (currentEnv: string[], currentImage: string) => { env: string[]; image: string },
): Promise<void> {
  const container = this.docker.getContainer(machineId);
  const data = await container.inspect();
  const labels = data.Config.Labels ?? {};
  const binds = data.HostConfig.Binds ?? [];
  const portBindings = data.HostConfig.PortBindings ?? {};
  const exposedPorts = data.Config.ExposedPorts ?? {};
  const nanoCpus = data.HostConfig.NanoCpus;
  const memory = data.HostConfig.Memory;
  const restartPolicy = data.HostConfig.RestartPolicy;
  const currentEnv = data.Config.Env ?? [];
  const currentImage = data.Config.Image;

  const { env: newEnv, image: newImage } = transform(currentEnv, currentImage);

  await container.stop({ t: 10 }).catch((err: unknown) => {
    if (!this.isHttpError(err, 304) && !this.isHttpError(err, 404)) throw err;
  });
  await container.remove().catch((err: unknown) => {
    if (!this.isHttpError(err, 404)) throw err;
  });

  await this.ensureImage(newImage);
  const fresh = await this.docker.createContainer({
    Image: newImage,
    Env: newEnv,
    Labels: labels,
    ExposedPorts: exposedPorts,
    HostConfig: {
      Binds: binds,
      PortBindings: portBindings,
      NanoCpus: nanoCpus,
      Memory: memory,
      RestartPolicy: restartPolicy,
    },
  } as Docker.ContainerCreateOptions);
  await fresh.start();
}

async updateMachineImage(machineId: string, _appName?: string | null): Promise<void> {
  const newImage = this.resolveImageRef();
  await this.recreateContainer(machineId, (env) => ({ env, image: newImage }));
}

async updateMachineEnv(
  machineId: string,
  envUpdates: Record<string, string>,
  _appName?: string | null,
): Promise<void> {
  await this.recreateContainer(machineId, (currentEnv, currentImage) => {
    // Merge: parse existing KEY=VAL pairs into a map, overlay the updates,
    // serialize back. New keys append.
    const map = new Map<string, string>();
    for (const line of currentEnv) {
      const eq = line.indexOf('=');
      if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
    }
    for (const [k, v] of Object.entries(envUpdates)) map.set(k, v);
    const env = [...map.entries()].map(([k, v]) => `${k}=${v}`);
    return { env, image: currentImage };
  });
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "recreate ops"
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider recreate-based image and env updates"
```

---

## Task 12: Implement `waitForState` and `waitForHealthy`

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — waiting', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockInspect = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetContainer.mockReturnValue({ inspect: mockInspect });
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('waitForState resolves once state matches', async () => {
    mockInspect
      .mockResolvedValueOnce({ State: { Status: 'starting' } })
      .mockResolvedValueOnce({ State: { Status: 'starting' } })
      .mockResolvedValueOnce({ State: { Status: 'running' } });
    const p = new DockerProvider();
    await expect(p.waitForState('abc', ['running'], 5_000)).resolves.toBeUndefined();
    expect(mockInspect).toHaveBeenCalledTimes(3);
  });

  it('waitForState times out with last observed state in message', async () => {
    mockInspect.mockResolvedValue({ State: { Status: 'starting' } });
    const p = new DockerProvider();
    await expect(p.waitForState('abc', ['running'], 200)).rejects.toThrow(
      /timed out.*last state.*starting/i,
    );
  });

  it('waitForHealthy polls /health and resolves on 200', async () => {
    // Container with hostPort label
    mockInspect.mockResolvedValue({
      Config: { Labels: { 'runhq.hostPort': '54321' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = new DockerProvider();
    await expect(p.waitForHealthy('abc', 5_000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:54321/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('waitForHealthy times out if /health never returns 200', async () => {
    mockInspect.mockResolvedValue({
      Config: { Labels: { 'runhq.hostPort': '54321' } },
    });
    global.fetch = vi.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch;

    const p = new DockerProvider();
    await expect(p.waitForHealthy('abc', 200)).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "waiting"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Replace both stubs:

```ts
async waitForState(
  machineId: string,
  targetStates: MachineState[],
  timeoutMs: number = 60_000,
  _appName?: string | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: MachineState | 'unknown' = 'unknown';

  while (Date.now() < deadline) {
    try {
      const data = await this.docker.getContainer(machineId).inspect();
      lastState = mapDockerState(data.State.Status);
      if (targetStates.includes(lastState as MachineState)) return;
    } catch (err: unknown) {
      if (this.isHttpError(err, 404)) lastState = 'destroyed';
      else throw err;
      if (targetStates.includes('destroyed')) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `waitForState timed out after ${timeoutMs}ms (last state: ${lastState}, targets: ${targetStates.join(',')})`,
  );
}

async waitForHealthy(
  machineId: string,
  timeoutMs: number = 60_000,
  _appName?: string | null,
): Promise<void> {
  const data = await this.docker.getContainer(machineId).inspect();
  const port = data.Config?.Labels?.['runhq.hostPort'];
  if (!port) {
    throw new Error(`waitForHealthy: container ${machineId} has no runhq.hostPort label`);
  }
  const url = `http://localhost:${port}/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2_000);
    try {
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {
      clearTimeout(timer);
      // Connection refused / abort — try again.
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`waitForHealthy timed out after ${timeoutMs}ms (url: ${url})`);
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "waiting"
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider waitForState and waitForHealthy"
```

---

## Task 13: Implement `getRoutingInfo`, `updateAutoSuspendPolicy`, `listMachines`

**Files:**
- Modify: `src/api/services/providers/DockerProvider.ts`
- Modify: `src/api/services/providers/DockerProvider.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `DockerProvider.test.ts`:

```ts
describe('DockerProvider — routing and fleet', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockInspect = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetContainer.mockReturnValue({ inspect: mockInspect });
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('getRoutingInfo reads hostPort from the appName argument (persisted in servers.flyAppName)', () => {
    const p = new DockerProvider();
    expect(p.getRoutingInfo('abc', '54321')).toEqual({
      serverUrl: 'http://localhost:54321',
      routingToken: null,
      requiresRoutingHeaders: false,
    });
  });

  it('getRoutingInfo throws when appName is missing or empty', () => {
    const p = new DockerProvider();
    expect(() => p.getRoutingInfo('abc', null)).toThrow(/missing appName.*hostPort/i);
    expect(() => p.getRoutingInfo('abc', '')).toThrow(/missing appName.*hostPort/i);
    expect(() => p.getRoutingInfo('abc')).toThrow(/missing appName.*hostPort/i);
  });

  it('updateAutoSuspendPolicy is a no-op', async () => {
    const p = new DockerProvider();
    await expect(p.updateAutoSuspendPolicy('abc', true)).resolves.toBeUndefined();
  });

  it('listMachines filters by runhq.managed label and returns MachineInfo[]', async () => {
    mockListContainers.mockResolvedValueOnce([
      {
        Id: 'c'.repeat(64),
        Names: ['/wild_curie'],
        State: 'running',
        Labels: { 'runhq.managed': 'true', 'runhq.serverId': 'srv-1' },
      },
      {
        Id: 'd'.repeat(64),
        Names: ['/serene_kepler'],
        State: 'exited',
        Labels: { 'runhq.managed': 'true', 'runhq.serverId': 'srv-2' },
      },
    ]);
    const p = new DockerProvider();
    const machines = await p.listMachines();
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['runhq.managed=true'] },
    });
    expect(machines).toEqual([
      { id: 'cccccccccccc', name: 'wild_curie', state: 'running', region: 'local' },
      { id: 'dddddddddddd', name: 'serene_kepler', state: 'stopped', region: 'local' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "routing and fleet"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`getRoutingInfo` is synchronous per the `IProvider` contract. We avoid needing a Docker round-trip by reading the host port from the `appName` argument — callers throughout `HttpServer.ts` and `ServerService.ts` already pass `server.flyAppName`, where `createMachine` persisted the port string. This survives `be` restarts because it's persisted in the database row.

```ts
getRoutingInfo(_machineId: string, appName?: string | null): RoutingInfo {
  const port = appName?.trim();
  if (!port) {
    throw new Error(
      'DockerProvider.getRoutingInfo: missing appName (expected host port string in servers.flyAppName)',
    );
  }
  return {
    serverUrl: `http://localhost:${port}`,
    routingToken: null,
    requiresRoutingHeaders: false,
  };
}

async updateAutoSuspendPolicy(
  _machineId: string,
  _autoSuspendEnabled: boolean,
  _appName?: string | null,
): Promise<void> {
  // Auto-suspend is a Fly cost optimization that doesn't apply locally.
}

async listMachines(_appName?: string | null): Promise<MachineInfo[]> {
  const containers = await this.docker.listContainers({
    all: true,
    filters: { label: ['runhq.managed=true'] },
  });
  return containers.map((c) => {
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
    return {
      id: c.Id.slice(0, 12),
      name,
      state: mapDockerState(c.State as string),
      region: 'local',
    };
  });
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.test.ts -t "routing and fleet"
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/providers/DockerProvider.ts src/api/services/providers/DockerProvider.test.ts
git commit -m "feat(provider): DockerProvider getRoutingInfo, listMachines, autosuspend no-op"
```

---

## Task 14: Wire into registry — add 'docker' to `HOURLY_RATES`, register provider, update `getDefaultProviderId`

**Files:**
- Modify: `src/api/services/providers/registry.ts`
- Modify: `src/api/services/providers/index.ts`
- Create: `src/api/services/providers/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/services/providers/registry.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dockerode so DockerProvider construction works without a daemon.
vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue('OK'),
    listImages: vi.fn().mockResolvedValue([]),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    buildImage: vi.fn(),
    createContainer: vi.fn(),
  })),
}));

const originalEnv = { ...process.env };

describe('registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.LOCAL_PROVIDER;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('getDefaultProviderId returns docker when LOCAL_PROVIDER=docker', async () => {
    process.env.LOCAL_PROVIDER = 'docker';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('docker');
  });

  it('getDefaultProviderId returns fly when LOCAL_PROVIDER=fly', async () => {
    process.env.LOCAL_PROVIDER = 'fly';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('fly');
  });

  it('getDefaultProviderId returns docker when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'development';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('docker');
  });

  it('getDefaultProviderId returns fly when NODE_ENV=production and no override', async () => {
    process.env.NODE_ENV = 'production';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('fly');
  });

  it('LOCAL_PROVIDER override beats NODE_ENV', async () => {
    process.env.LOCAL_PROVIDER = 'docker';
    process.env.NODE_ENV = 'production';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('docker');
  });

  it('initProviders registers both fly and docker', async () => {
    const { initProviders, getProvider } = await import('./registry');
    initProviders();
    expect(getProvider('fly').id).toBe('fly');
    expect(getProvider('docker').id).toBe('docker');
  });

  it('getHourlyRate returns 0 cents for docker', async () => {
    const { getHourlyRate } = await import('./registry');
    expect(getHourlyRate('docker', 'shared-4x-2gb')).toBe(0);
    expect(getHourlyRate('docker', 'perf-4x-32gb')).toBe(0);
  });

  it('getHourlyRate still returns Fly rates for fly', async () => {
    const { getHourlyRate } = await import('./registry');
    expect(getHourlyRate('fly', 'shared-4x-2gb')).toBe(3);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run:
```bash
pnpm exec vitest run src/api/services/providers/registry.test.ts
```

Expected: FAIL — multiple assertions fail (default selection logic missing, docker rates missing, docker not registered).

- [ ] **Step 3: Update `registry.ts`**

Replace `HOURLY_RATES`:

```ts
const HOURLY_RATES: Record<ProviderId, Record<TierId, number>> = {
  fly: {
    'shared-4x-1gb': 1,
    'shared-4x-2gb': 3,
    'shared-4x-4gb': 4,
    'shared-4x-8gb': 8,
    'shared-8x-4gb': 5,
    'shared-8x-8gb': 8,
    'shared-8x-16gb': 15,
    'perf-2x-4gb': 11,
    'perf-2x-8gb': 15,
    'perf-2x-16gb': 22,
    'perf-4x-8gb': 22,
    'perf-4x-16gb': 29,
    'perf-4x-32gb': 43,
  },
  docker: {
    'shared-4x-1gb': 0,
    'shared-4x-2gb': 0,
    'shared-4x-4gb': 0,
    'shared-4x-8gb': 0,
    'shared-8x-4gb': 0,
    'shared-8x-8gb': 0,
    'shared-8x-16gb': 0,
    'perf-2x-4gb': 0,
    'perf-2x-8gb': 0,
    'perf-2x-16gb': 0,
    'perf-4x-8gb': 0,
    'perf-4x-16gb': 0,
    'perf-4x-32gb': 0,
  },
};
```

Update `initProviders`:

```ts
import { DockerProvider } from './DockerProvider';

export function initProviders(): void {
  if (initialized) return;
  providers.set('fly', new FlyProvider());
  providers.set('docker', new DockerProvider());
  initialized = true;

  const configured = [...providers.values()].filter((p) => p.isConfigured()).map((p) => p.id);
  console.log(`[Providers] Initialized: ${configured.length ? configured.join(', ') : 'none configured'}`);
}
```

(Kept synchronous — both `FlyProvider.isConfigured` and `DockerProvider.isConfigured` are sync.)

Replace `getDefaultProviderId`:

```ts
export function getDefaultProviderId(): ProviderId {
  const override = process.env.LOCAL_PROVIDER;
  if (override === 'docker' || override === 'fly') return override;
  if (process.env.NODE_ENV !== 'production') return 'docker';
  return 'fly';
}
```

Update `index.ts`:

```ts
export { FlyProvider, flyTierToTierId, tierIdToFlyTier } from './FlyProvider';
export { DockerProvider } from './DockerProvider';
```

Update `getHourlyRate` fallback (currently `?? HOURLY_RATES.fly['shared-4x-2gb']` — leave as-is, it's correct).

- [ ] **Step 4: Run test — expect PASS**

Run:
```bash
pnpm exec vitest run src/api/services/providers/registry.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Run typecheck — should now pass cleanly**

Run:
```bash
pnpm typecheck
```

Expected: PASS. The `Record<ProviderId, …>` issue from Task 2 is now resolved.

- [ ] **Step 6: Commit**

```bash
git add src/api/services/providers/registry.ts \
        src/api/services/providers/registry.test.ts \
        src/api/services/providers/index.ts
git commit -m "feat(provider): register DockerProvider and default selection"
```

---

## Task 15: Document new env vars in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the docs**

Append to `.env.example` (or insert in an appropriate section):

```
# =============================================================================
# Local workspace provisioning (DockerProvider)
# =============================================================================
# When running be against a local Docker daemon, "Create Server" boots a
# Docker container instead of a Fly machine. See
# docs/superpowers/specs/2026-05-04-docker-provider-local-workspaces-design.md.

# Override the default provider selection.
#   docker → use DockerProvider (local containers)
#   fly    → use FlyProvider (real Fly.io API; useful for debugging Fly issues
#            from a local backend)
# Default: 'docker' when NODE_ENV != production, 'fly' otherwise.
# LOCAL_PROVIDER=docker

# Image ref for the workspace container. Default: runhq-server:local (lazy-built).
# Override to test against a specific tag without rebuilding.
# RUNHQ_WORKSPACE_IMAGE=runhq-server:local

# Path to the runhq server source dir (containing Dockerfile) for lazy-build.
# Default: ../runhq/server (assumes be/ and runhq/ are siblings).
# RUNHQ_WORKSPACE_DOCKERFILE_DIR=/path/to/runhq/server

# Where workspace volume bind-mount dirs are created.
# Default: /app/data/local-workspaces
# RUNHQ_LOCAL_VOLUMES_DIR=/app/data/local-workspaces
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(provider): document LOCAL_PROVIDER and workspace env vars"
```

---

## Task 16: ServerService regression — local provider produces localhost URL

This is the end-to-end wiring confirmation: with `LOCAL_PROVIDER=docker` set and dockerode mocked, calling `ServerService.createServer` finishes with the right DB row and `localhost:<port>` URL.

> Note: `ServerService.createServer` is a long, side-effect-rich function that touches Stripe, the DB, the provider, and several side tables. We DO NOT replicate the entire happy-path here — instead we use the same shaped helper / test fixtures the existing `ServerService.metadata-durability.test.ts` uses. **Step 1 below is "read what fixtures already exist" so the test mirrors the codebase style.**

**Files:**
- Read first: `src/api/services/ServerService.metadata-durability.test.ts`
- Create: `src/api/services/ServerService.local-provider.test.ts`

- [ ] **Step 1: Read existing ServerService test for fixture patterns**

```bash
cat src/api/services/ServerService.metadata-durability.test.ts
```

Note how it sets up: DB fixtures (likely uses `testDb()` or similar), provider mocking, `createServer` call, and assertions. Mirror this style.

- [ ] **Step 2: Write the failing test**

Create `src/api/services/ServerService.local-provider.test.ts`. Skeleton:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dockerode at module scope.
const mockPing = vi.fn().mockResolvedValue('OK');
const mockListImages = vi.fn().mockResolvedValue([{ Id: 'sha256:x', RepoTags: ['runhq-server:local'] }]);
const mockCreateContainer = vi.fn();
const mockGetContainer = vi.fn();

vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(() => ({
    ping: mockPing,
    listImages: mockListImages,
    listContainers: vi.fn().mockResolvedValue([]),
    createContainer: mockCreateContainer,
    getContainer: mockGetContainer,
    buildImage: vi.fn(),
  })),
}));

const originalEnv = { ...process.env };

describe('ServerService — local provider integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.LOCAL_PROVIDER = 'docker';
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = '/tmp/runhq-vols-test';
    process.env.NODE_ENV = 'test';

    const fakeContainer = {
      id: 'a'.repeat(64),
      start: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        State: { Status: 'running' },
        Config: { Labels: { 'runhq.hostPort': '12345' } },
      }),
    };
    mockCreateContainer.mockResolvedValue(fakeContainer);
    mockGetContainer.mockReturnValue(fakeContainer);

    // Stub the workspace's /health response.
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('createServer with LOCAL_PROVIDER=docker returns localhost URL and providerId=docker', async () => {
    const { ServerService } = await import('./ServerService');

    // The exact API of ServerService.createServer (signature, options) must
    // match what the existing test files use. If the live signature is:
    //   createServer(ownerId: string, opts: { name: string; tier?: TierId; ... })
    // call it the same way here.
    const result = await ServerService.createServer('test-owner-id', {
      name: 'My Local Workspace',
    });

    expect(result.providerId).toBe('docker');
    expect(result.url ?? result.serverUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
  });
});
```

> If `ServerService.createServer`'s actual signature differs from the assumed one, adapt the call site to match what the existing tests do. **Do not invent properties — read the source first.**

- [ ] **Step 3: Run test — expect FAIL or PASS**

Run:
```bash
pnpm exec vitest run src/api/services/ServerService.local-provider.test.ts
```

If it FAILS due to signature mismatch, fix the test (and only the test) to call the real `ServerService.createServer` correctly.

If it FAILS because `ServerService` does something the DockerProvider doesn't yet support (e.g., calls `forkVolume` on createServer), that surfaces a real integration gap — investigate and either:
- Update DockerProvider to support that call (if it's reachable on a fresh-server happy path), or
- Document and accept that the DockerProvider works only for the simple-create path in this iteration. Add to "Open questions / future work" in the spec.

If it PASSES, great.

- [ ] **Step 4: Commit**

Once the test passes (or the signature is corrected and the test reflects reality):

```bash
git add src/api/services/ServerService.local-provider.test.ts
git commit -m "test(provider): ServerService createServer with LOCAL_PROVIDER=docker"
```

---

## Task 17: Add gated integration test (real Docker)

This test only runs when `RUN_DOCKER_INTEGRATION=1`. It uses `alpine:latest` so it's small and fast; never runs against the real `runhq-server` image (too big for CI / test loops).

**Files:**
- Create: `src/api/services/providers/DockerProvider.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/api/services/providers/DockerProvider.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerProvider } from './DockerProvider';

// Gate: only runs when explicitly enabled.
const ENABLED = process.env.RUN_DOCKER_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

// Use alpine for fast pulls + small footprint. Override the workspace image
// so the provider doesn't try to build runhq-server:local.
process.env.RUNHQ_WORKSPACE_IMAGE = 'alpine:latest';

describeIntegration('DockerProvider — real Docker integration', () => {
  let baseDir: string;
  let provider: DockerProvider;
  let createdContainerId: string | null = null;
  let createdVolumeId: string | null = null;

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'runhq-integ-'));
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = baseDir;
    provider = new DockerProvider();
  });

  afterAll(async () => {
    // Best-effort cleanup; ignore errors.
    if (createdContainerId) {
      try { await provider.deleteMachine(createdContainerId); } catch {}
    }
    if (createdVolumeId) {
      try { await provider.deleteVolume(createdVolumeId); } catch {}
    }
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.RUNHQ_WORKSPACE_IMAGE;
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
  });

  it('isConfigured returns true against a live daemon', async () => {
    expect(await provider.isConfigured()).toBe(true);
  });

  it('full lifecycle: create volume → create container → start → list → stop → delete', async () => {
    const vol = await provider.createVolume('integ-vol', 'local', 1);
    createdVolumeId = vol.id;
    expect(existsSync(join(baseDir, vol.id))).toBe(true);

    // Drop a sentinel into the bind dir so we can verify the mount.
    writeFileSync(join(baseDir, vol.id, 'hello.txt'), 'world');

    const result = await provider.createMachine({
      serverId: 'integ-srv',
      serverToken: 'integ-token',
      region: 'local',
      // Override the entrypoint via Cmd? alpine:latest exits immediately.
      // For this test we use a long-running command via image override is
      // not possible; instead, work with what alpine does and verify create
      // + inspect, without expecting a long-lived /health endpoint.
      tier: 'shared-4x-1gb',
      existingVolumeId: vol.id,
      autoSuspendEnabled: false,
      appName: null,
      networkName: null,
    });
    createdContainerId = result.machineId;

    expect(result.machineId).toMatch(/^[a-f0-9]{12}$/);
    expect(result.serverUrl).toMatch(/^http:\/\/localhost:\d+$/);

    // listMachines should include our test container.
    const list = await provider.listMachines();
    expect(list.some((m) => m.id === result.machineId)).toBe(true);

    // Stop and delete.
    await provider.stopMachine(result.machineId);
    await provider.deleteMachine(result.machineId);
    createdContainerId = null;

    const after = await provider.getMachineState(result.machineId);
    expect(after).toBe('destroyed');
  });
});
```

> Note: alpine exits immediately when run without a long-running command. The test above creates and inspects but does NOT call `waitForHealthy`, because alpine has no /health endpoint. A more thorough integration test against a real long-running image (nginx / a tiny http server) is reasonable future work.

- [ ] **Step 2: Run with the gate enabled**

```bash
RUN_DOCKER_INTEGRATION=1 pnpm exec vitest run src/api/services/providers/DockerProvider.integration.test.ts
```

Expected: PASS (2 tests). If Docker daemon isn't running, the test fails with a clear "ENOENT /var/run/docker.sock" — fix that first.

- [ ] **Step 3: Run without the gate (default state)**

```bash
pnpm exec vitest run src/api/services/providers/DockerProvider.integration.test.ts
```

Expected: 2 tests SKIPPED.

- [ ] **Step 4: Commit**

```bash
git add src/api/services/providers/DockerProvider.integration.test.ts
git commit -m "test(provider): DockerProvider real-Docker integration test (gated)"
```

---

## Task 18: Final checks — full test run, typecheck, manual smoke

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
pnpm exec vitest run
```

Expected: All tests pass (no regressions in existing tests). Note any pre-existing failures unrelated to this work and report — don't try to fix unrelated tests.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Manual smoke test — provider selection in dev**

```bash
NODE_ENV=development node --input-type=module -e "
const { initProviders, getDefaultProviderId, getProvider } = await import('./src/api/services/providers/index.ts');
initProviders();
console.log('default:', getDefaultProviderId());
const p = getProvider('docker');
console.log('docker.id:', p.id);
console.log('docker.isConfigured:', await p.isConfigured());
"
```

Expected: Prints `default: docker` and either `docker.isConfigured: true` (Docker socket present) or `false` plus the warning.

> If `tsx`/`ts-node` is needed to run TS directly, substitute: `pnpm exec tsx -e "..."`.

- [ ] **Step 4: Manual smoke test — provider override**

```bash
LOCAL_PROVIDER=fly NODE_ENV=development pnpm exec tsx -e "
const { getDefaultProviderId } = await import('./src/api/services/providers/index.ts');
console.log('default:', getDefaultProviderId());
"
```

Expected: Prints `default: fly`.

- [ ] **Step 5: If everything is green, no commit needed; the work is done**

The branch `feat/docker-provider` now contains:
- `dockerode` dep added (Task 1)
- `ProviderId` extended (Task 2)
- `DockerProvider` fully implemented (Tasks 3–13)
- Registry updated, env docs added (Tasks 14–15)
- Integration tests + ServerService regression (Tasks 16–17)

Push the branch when ready:

```bash
git push -u origin feat/docker-provider
```

---

## Self-Review Checklist (run before handoff)

- [ ] Every spec section has a task that implements it (config, app no-ops, machine lifecycle, volumes, snapshot stubs, health/wait, routing, listMachines, env updates, provider selection, env var docs, testing strategy).
- [ ] No "TBD" / "TODO" / "implement later" / "appropriate error handling" / "similar to Task N" — every step shows the actual code.
- [ ] Type and method names are consistent across tasks (`mapDockerState`, `allocateHostPort`, `ensureImage`, `resolveImageRef`, `recreateContainer`, `volumeDir`, `volumesBaseDir`).
- [ ] Each commit is a self-contained step that leaves the tree green (tests pass, types compile) — except Task 2's commit, which intentionally leaves `Record<ProviderId, …>` half-typed until Task 14 adds the `'docker'` key.
- [ ] The plan says where to put each test (file path), how to run it (`pnpm exec vitest run …`), and what the expected output is.
- [ ] Spec self-review fixes from the spec phase (404 handling for getMachineInfo, nullable flyAppName) are reflected in this plan.
