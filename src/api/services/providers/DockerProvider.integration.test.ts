/**
 * Integration tests for DockerProvider against a real Docker daemon.
 *
 * Gated behind RUN_DOCKER_INTEGRATION=1 because they require a working
 * Docker socket and pull the alpine:latest image (~5 MB) on first run.
 *
 *   RUN_DOCKER_INTEGRATION=1 pnpm exec vitest run \
 *     src/api/services/providers/DockerProvider.integration.test.ts
 *
 * CI does not run these. Local developers can.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerProvider } from './DockerProvider';

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
    if (createdContainerId) {
      try { await provider.deleteMachine(createdContainerId); } catch { /* ignore */ }
    }
    if (createdVolumeId) {
      try { await provider.deleteVolume(createdVolumeId); } catch { /* ignore */ }
    }
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.RUNHQ_WORKSPACE_IMAGE;
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
  });

  it('isConfigured returns true against a live daemon', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('full lifecycle: create volume → create container → list → stop → delete', async () => {
    const vol = await provider.createVolume('integ-vol', 'local', 1);
    createdVolumeId = vol.id;
    expect(existsSync(join(baseDir, vol.id))).toBe(true);

    // Drop a sentinel into the bind dir so we can verify the mount exists.
    writeFileSync(join(baseDir, vol.id, 'hello.txt'), 'world');

    const result = await provider.createMachine({
      serverId: 'integ-srv',
      serverToken: 'integ-token',
      region: 'local',
      // alpine exits immediately without a long-running command, so we don't
      // call waitForHealthy. The lifecycle assertions below are still meaningful.
      tier: 'shared-4x-1gb',
      existingVolumeId: vol.id,
      autoSuspendEnabled: false,
      appName: null,
      networkName: null,
    });
    createdContainerId = result.machineId;

    expect(result.machineId).toMatch(/^[a-f0-9]{12}$/);
    expect(result.serverUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(result.appName).toMatch(/^\d+$/);

    const list = await provider.listMachines();
    expect(list.some((m) => m.id === result.machineId)).toBe(true);

    await provider.stopMachine(result.machineId);
    await provider.deleteMachine(result.machineId);
    createdContainerId = null;

    const after = await provider.getMachineState(result.machineId);
    expect(after).toBe('destroyed');
  });
});
