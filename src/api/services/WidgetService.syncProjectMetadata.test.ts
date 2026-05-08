import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { widgetProjects } from '../../db/schema';
import {
  enableWidget,
  syncProjectMetadata,
  getWidgetIntegration,
} from './WidgetService';

const RUN = randomBytes(6).toString('hex');
const SERVER_A = `ws_spm_${RUN}_a`;
const SERVER_B = `ws_spm_${RUN}_b`;
const PROJ_1 = `proj_spm_${RUN}_1`;
const PROJ_2 = `proj_spm_${RUN}_2`;
const PROJ_3 = `proj_spm_${RUN}_3`;
const PROJ_ORPHAN = `proj_spm_${RUN}_orphan`;

beforeAll(async () => {
  await db.insert(widgetProjects).values([
    {
      serverId: SERVER_A,
      workspaceProjectId: PROJ_1,
      name: 'Original Name 1',
      slug: `slug-1-${RUN}`,
      apiKey: `k1-${RUN}`,
      apiSecretHash: `s1-${RUN}`,
      enabled: true,
      channelId: `ch-1-${RUN}`,
    },
    {
      serverId: SERVER_A,
      workspaceProjectId: PROJ_2,
      name: 'Original Name 2',
      slug: `slug-2-${RUN}`,
      apiKey: `k2-${RUN}`,
      apiSecretHash: `s2-${RUN}`,
      enabled: true,
      channelId: `ch-2-${RUN}`,
    },
    {
      serverId: SERVER_B,
      workspaceProjectId: PROJ_3,
      name: 'Other Server Project',
      slug: `slug-3-${RUN}`,
      apiKey: `k3-${RUN}`,
      apiSecretHash: `s3-${RUN}`,
      enabled: true,
      channelId: `ch-3-${RUN}`,
    },
  ]);
});

afterAll(async () => {
  await db.delete(widgetProjects).where(inArray(widgetProjects.serverId, [SERVER_A, SERVER_B]));
});

describe('WidgetService.syncProjectMetadata', () => {
  it('updates name when it has changed', async () => {
    const result = await syncProjectMetadata(SERVER_A, [
      { id: PROJ_1, name: '제주닷컴' },
    ]);

    expect(result.updated).toBe(1);
    const row = await getWidgetIntegration(SERVER_A, PROJ_1);
    expect(row?.name).toBe('제주닷컴');
  });

  it('is idempotent — second call with same name reports no updates', async () => {
    await syncProjectMetadata(SERVER_A, [{ id: PROJ_1, name: 'Stable Name' }]);
    const second = await syncProjectMetadata(SERVER_A, [{ id: PROJ_1, name: 'Stable Name' }]);
    expect(second.updated).toBe(0);
  });

  it('handles multiple projects in one call, only counting actual changes', async () => {
    // Reset both to known state
    await db.update(widgetProjects)
      .set({ name: 'Reset 1' })
      .where(eq(widgetProjects.workspaceProjectId, PROJ_1));
    await db.update(widgetProjects)
      .set({ name: 'Reset 2' })
      .where(eq(widgetProjects.workspaceProjectId, PROJ_2));

    const result = await syncProjectMetadata(SERVER_A, [
      { id: PROJ_1, name: 'New 1' },     // change
      { id: PROJ_2, name: 'Reset 2' },   // no change
    ]);

    expect(result.updated).toBe(1);
    const a = await getWidgetIntegration(SERVER_A, PROJ_1);
    const b = await getWidgetIntegration(SERVER_A, PROJ_2);
    expect(a?.name).toBe('New 1');
    expect(b?.name).toBe('Reset 2');
  });

  it('is scoped per serverId — does not touch rows on other servers', async () => {
    const before = await getWidgetIntegration(SERVER_B, PROJ_3);
    expect(before?.name).toBe('Other Server Project');

    // Push a project with the SAME workspaceProjectId-ish name to SERVER_A's
    // namespace; SERVER_B's row must remain untouched.
    await syncProjectMetadata(SERVER_A, [{ id: PROJ_3, name: 'Should Not Apply' }]);

    const after = await getWidgetIntegration(SERVER_B, PROJ_3);
    expect(after?.name).toBe('Other Server Project');
  });

  it('skips projects that have no widget_projects row (orphan workspace projects)', async () => {
    const result = await syncProjectMetadata(SERVER_A, [
      { id: PROJ_ORPHAN, name: 'Will Not Land' },
    ]);
    expect(result.updated).toBe(0);
  });

  it('accepts an empty list and reports zero updates without touching the DB', async () => {
    const result = await syncProjectMetadata(SERVER_A, []);
    expect(result.updated).toBe(0);
  });

  it('updates updatedAt when name actually changes', async () => {
    await db.update(widgetProjects)
      .set({ name: 'Pre-Sync', updatedAt: new Date('2020-01-01') })
      .where(eq(widgetProjects.workspaceProjectId, PROJ_1));

    await syncProjectMetadata(SERVER_A, [{ id: PROJ_1, name: 'Post-Sync' }]);

    const [row] = await db
      .select({ updatedAt: widgetProjects.updatedAt })
      .from(widgetProjects)
      .where(eq(widgetProjects.workspaceProjectId, PROJ_1));
    expect(row.updatedAt.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
  });
});

describe('WidgetService.syncProjectMetadata — round-trip with enableWidget', () => {
  // Independent server so the reset block above doesn't interfere.
  const RT_RUN = randomBytes(6).toString('hex');
  const RT_SERVER = `ws_spm_rt_${RT_RUN}`;
  const RT_PROJ = `proj_spm_rt_${RT_RUN}`;

  beforeEach(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, RT_SERVER));
  });

  afterAll(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, RT_SERVER));
  });

  it('a rename pushed via syncProjectMetadata is visible to subsequent widget reads', async () => {
    await enableWidget(RT_SERVER, {
      name: 'jeju-legacy',
      channelId: `ch-rt-${RT_RUN}`,
      workspaceProjectId: RT_PROJ,
    });

    const before = await getWidgetIntegration(RT_SERVER, RT_PROJ);
    expect(before?.name).toBe('jeju-legacy');

    const result = await syncProjectMetadata(RT_SERVER, [{ id: RT_PROJ, name: '제주닷컴' }]);
    expect(result.updated).toBe(1);

    const after = await getWidgetIntegration(RT_SERVER, RT_PROJ);
    expect(after?.name).toBe('제주닷컴');
  });
});
