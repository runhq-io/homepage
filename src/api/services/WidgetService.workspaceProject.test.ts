import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { widgetProjects } from '../../db/schema';
import {
  getWidgetIntegration,
  getWidgetSettings,
  getPreviewWidgetFlag,
  generatePreviewWidgetBootstrap,
  enableWidget,
  disableWidget,
  updateWidgetSettings,
  reconcileUnbackfilledWidgets,
} from './WidgetService';

const RUN = randomBytes(6).toString('hex');
const SERVER = `ws_wp_${RUN}`;
const PROJ_A = `proj_test_${RUN}_a`;
const PROJ_B = `proj_test_${RUN}_b`;
const insertedIds: string[] = [];

beforeAll(async () => {
  const rows = await db.insert(widgetProjects).values([
    {
      serverId: SERVER,
      workspaceProjectId: PROJ_A,
      name: 'Moddio',
      slug: `moddio-${RUN}`,
      apiKey: `k-moddio-${RUN}`,
      apiSecretHash: `s-moddio-${RUN}`,
      enabled: true,
      autoInjectInPreview: false,
      channelId: `ch-moddio-${RUN}`,
    },
    {
      serverId: SERVER,
      workspaceProjectId: PROJ_B,
      name: 'Snek',
      slug: `snek-${RUN}`,
      apiKey: `k-snek-${RUN}`,
      apiSecretHash: `s-snek-${RUN}`,
      enabled: true,
      autoInjectInPreview: false,
      channelId: `ch-snek-${RUN}`,
    },
  ]).returning({ id: widgetProjects.id });
  insertedIds.push(...rows.map(r => r.id));
});

afterAll(async () => {
  if (insertedIds.length > 0) {
    await db.delete(widgetProjects).where(inArray(widgetProjects.id, insertedIds));
  }
});

describe('WidgetService — per-project isolation (reads)', () => {
  it('getWidgetIntegration returns the row scoped to the requested workspace project', async () => {
    const a = await getWidgetIntegration(SERVER, PROJ_A);
    const b = await getWidgetIntegration(SERVER, PROJ_B);
    expect(a?.name).toBe('Moddio');
    expect(b?.name).toBe('Snek');
  });

  it('getWidgetSettings is scoped to (serverId, workspaceProjectId)', async () => {
    const a = await getWidgetSettings(SERVER, PROJ_A);
    const b = await getWidgetSettings(SERVER, PROJ_B);
    expect(a?.slug).toBe(`moddio-${RUN}`);
    expect(b?.slug).toBe(`snek-${RUN}`);
  });

  it('getPreviewWidgetFlag is scoped to (serverId, workspaceProjectId)', async () => {
    await db.update(widgetProjects)
      .set({ autoInjectInPreview: true })
      .where(eq(widgetProjects.slug, `moddio-${RUN}`));
    const a = await getPreviewWidgetFlag(SERVER, PROJ_A);
    const b = await getPreviewWidgetFlag(SERVER, PROJ_B);
    expect(a).toEqual({ shouldInject: true, projectSlug: `moddio-${RUN}` });
    expect(b).toEqual({ shouldInject: false });
  });

  it('generatePreviewWidgetBootstrap uses the per-project row', async () => {
    // Moddio still has autoInjectInPreview=true from previous test.
    const out = await generatePreviewWidgetBootstrap(SERVER, 'user-1', 'Alice', PROJ_A);
    expect(out?.config.projectSlug).toBe(`moddio-${RUN}`);
    const none = await generatePreviewWidgetBootstrap(SERVER, 'user-1', 'Alice', PROJ_B);
    expect(none).toBeNull();
  });

  it('omitting workspaceProjectId falls back to legacy serverId-only behavior (backward compat)', async () => {
    const anyOne = await getWidgetIntegration(SERVER);
    expect(['Moddio', 'Snek']).toContain(anyOne?.name);
  });
});

// ============================================================================
// Write-path tests
// ============================================================================

describe('WidgetService — per-project writes', () => {
  // Use a separate set of constants so this block is self-contained and
  // doesn't collide with the read-block's beforeAll-seeded data.
  const WRUN = randomBytes(6).toString('hex');
  const WSERVER = `ws_ww_${WRUN}`;
  const WPROJ_A = `proj_w_${WRUN}_a`;
  const WPROJ_B = `proj_w_${WRUN}_b`;

  beforeEach(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, WSERVER));
  });

  afterAll(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, WSERVER));
  });

  it('enableWidget creates one row per (serverId, workspaceProjectId)', async () => {
    const a = await enableWidget(WSERVER, { name: 'Moddio', channelId: `ch-a-${WRUN}`, workspaceProjectId: WPROJ_A });
    const b = await enableWidget(WSERVER, { name: 'Snek',   channelId: `ch-b-${WRUN}`, workspaceProjectId: WPROJ_B });
    expect(a.id).not.toBe(b.id);
    expect(a.workspaceProjectId).toBe(WPROJ_A);
    expect(b.workspaceProjectId).toBe(WPROJ_B);
  });

  it('enableWidget for an existing (server, project) re-enables and rotates secret without creating a duplicate row', async () => {
    const first  = await enableWidget(WSERVER, { name: 'Moddio', channelId: `ch-a-${WRUN}`, workspaceProjectId: WPROJ_A });
    const second = await enableWidget(WSERVER, { name: 'Moddio', channelId: `ch-a-${WRUN}`, workspaceProjectId: WPROJ_A });
    expect(second.id).toBe(first.id);
    expect(second.apiSecretHash).not.toBe(first.apiSecretHash); // rotated
    const all = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, WSERVER));
    expect(all).toHaveLength(1);
  });

  it('enableWidget rejects calls without workspaceProjectId', async () => {
    await expect(
      enableWidget(WSERVER, { name: 'X', channelId: 'c' } as any),
    ).rejects.toThrow(/workspaceProjectId/);
  });

  it('disableWidget(serverId, workspaceProjectId) does not affect a sibling project on the same server', async () => {
    await enableWidget(WSERVER, { name: 'Moddio', channelId: `ch-a-${WRUN}`, workspaceProjectId: WPROJ_A });
    await enableWidget(WSERVER, { name: 'Snek',   channelId: `ch-b-${WRUN}`, workspaceProjectId: WPROJ_B });
    await disableWidget(WSERVER, WPROJ_A);
    const a = await getWidgetIntegration(WSERVER, WPROJ_A);
    const b = await getWidgetIntegration(WSERVER, WPROJ_B);
    expect(a).toBeNull();   // disabled = enabled:false; getWidgetIntegration filters enabled=true
    expect(b?.name).toBe('Snek');
  });

  it('updateWidgetSettings only updates the targeted project row', async () => {
    await enableWidget(WSERVER, { name: 'Moddio', channelId: `ch-a-${WRUN}`, workspaceProjectId: WPROJ_A });
    await enableWidget(WSERVER, { name: 'Snek',   channelId: `ch-b-${WRUN}`, workspaceProjectId: WPROJ_B });
    await updateWidgetSettings(WSERVER, { is_public: true }, { workspaceProjectId: WPROJ_A });
    const a = await getWidgetSettings(WSERVER, WPROJ_A);
    const b = await getWidgetSettings(WSERVER, WPROJ_B);
    expect(a?.is_public).toBe(true);
    expect(b?.is_public).toBe(false);
  });
});

// ============================================================================
// Reconcile tests
// ============================================================================

describe('reconcileUnbackfilledWidgets', () => {
  const RRUN = randomBytes(6).toString('hex');
  const RSERVER = `ws_rec_${RRUN}`;
  const RPROJ = `proj_rec_${RRUN}`;
  const ORPHAN_CHANNEL = `ch_orphan_${RRUN}`;
  const KNOWN_CHANNEL = `ch_known_${RRUN}`;

  beforeEach(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, RSERVER));
  });

  afterAll(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, RSERVER));
  });

  it('fills workspace_project_id for rows whose channel appears in the map', async () => {
    await db.insert(widgetProjects).values({
      serverId: RSERVER,
      // Note: workspace_project_id intentionally NULL.
      name: 'Old', slug: `old-${RRUN}`, apiKey: `k-${RRUN}`, apiSecretHash: `s-${RRUN}`,
      enabled: true, channelId: KNOWN_CHANNEL,
    });

    const result = await reconcileUnbackfilledWidgets(RSERVER, {
      [KNOWN_CHANNEL]: RPROJ,
    });
    expect(result.updated).toBe(1);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, RSERVER));
    expect(row.workspaceProjectId).toBe(RPROJ);
  });

  it('leaves rows alone when their channel is not in the map (channel may have been deleted)', async () => {
    await db.insert(widgetProjects).values({
      serverId: RSERVER, name: 'Lost', slug: `lost-${RRUN}`,
      apiKey: `k-${RRUN}`, apiSecretHash: `s-${RRUN}`, enabled: true, channelId: ORPHAN_CHANNEL,
    });

    const result = await reconcileUnbackfilledWidgets(RSERVER, {
      [`ch_other_${RRUN}`]: RPROJ,
    });
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, RSERVER));
    expect(row.workspaceProjectId).toBeNull();
  });

  it('is idempotent — already-populated rows are skipped', async () => {
    await db.insert(widgetProjects).values({
      serverId: RSERVER,
      workspaceProjectId: RPROJ, // already populated
      name: 'Already', slug: `already-${RRUN}`,
      apiKey: `k-${RRUN}`, apiSecretHash: `s-${RRUN}`, enabled: true, channelId: KNOWN_CHANNEL,
    });

    const result = await reconcileUnbackfilledWidgets(RSERVER, {
      [KNOWN_CHANNEL]: `proj_DIFFERENT_${RRUN}`, // ignored, row already populated
    });
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, RSERVER));
    expect(row.workspaceProjectId).toBe(RPROJ); // unchanged
  });

  it('skips rows with NULL channel_id (no way to resolve them)', async () => {
    await db.insert(widgetProjects).values({
      serverId: RSERVER, name: 'NoCh', slug: `noch-${RRUN}`,
      apiKey: `k-${RRUN}`, apiSecretHash: `s-${RRUN}`, enabled: true, channelId: null,
    });

    const result = await reconcileUnbackfilledWidgets(RSERVER, { [KNOWN_CHANNEL]: RPROJ });
    expect(result.updated).toBe(0);
  });
});
