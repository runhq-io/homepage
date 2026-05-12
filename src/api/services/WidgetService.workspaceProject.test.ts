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
  reconcileWidgetBindings,
} from './WidgetService';

// Phase 5 of the widget-per-channel migration: channelId is the sole lookup
// key. This file (originally named workspaceProject.test.ts) is kept under its
// historical name to avoid renaming churn during the cleanup PR, but every
// test now exercises the channel-keyed write/read paths. The
// `workspace_project_id` column still exists as a cached parent reference and
// is asserted alongside the channel where relevant.

const RUN = randomBytes(6).toString('hex');
const SERVER = `ws_wp_${RUN}`;
const PROJ_A = `proj_test_${RUN}_a`;
const PROJ_B = `proj_test_${RUN}_b`;
const CHAN_A = `ch-moddio-${RUN}`;
const CHAN_B = `ch-snek-${RUN}`;
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
      channelId: CHAN_A,
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
      channelId: CHAN_B,
    },
  ]).returning({ id: widgetProjects.id });
  insertedIds.push(...rows.map(r => r.id));
});

afterAll(async () => {
  if (insertedIds.length > 0) {
    await db.delete(widgetProjects).where(inArray(widgetProjects.id, insertedIds));
  }
});

describe('WidgetService — per-channel isolation (reads)', () => {
  it('getWidgetIntegration is scoped to (serverId, channelId)', async () => {
    const a = await getWidgetIntegration(SERVER, { channelId: CHAN_A });
    const b = await getWidgetIntegration(SERVER, { channelId: CHAN_B });
    expect(a?.name).toBe('Moddio');
    expect(b?.name).toBe('Snek');
  });

  it('getWidgetSettings is scoped to (serverId, channelId)', async () => {
    const a = await getWidgetSettings(SERVER, { channelId: CHAN_A });
    const b = await getWidgetSettings(SERVER, { channelId: CHAN_B });
    expect(a?.slug).toBe(`moddio-${RUN}`);
    expect(b?.slug).toBe(`snek-${RUN}`);
  });

  it('getPreviewWidgetFlag (workspace-keyed) is scoped to (serverId, workspaceProjectId)', async () => {
    // Preview-proxy uses workspaceProjectId (workspace→BE path); the parameter
    // is intentionally NOT a WidgetLookup — see WidgetService.getPreviewWidgetFlag.
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

  it('omitting the lookup falls back to serverId-only behavior (admin "any row" path)', async () => {
    const anyOne = await getWidgetIntegration(SERVER);
    expect(['Moddio', 'Snek']).toContain(anyOne?.name);
  });
});

// ============================================================================
// Write-path tests
// ============================================================================

describe('WidgetService — per-channel writes', () => {
  // Use a separate set of constants so this block is self-contained and
  // doesn't collide with the read-block's beforeAll-seeded data.
  const WRUN = randomBytes(6).toString('hex');
  const WSERVER = `ws_ww_${WRUN}`;
  const WPROJ_A = `proj_w_${WRUN}_a`;
  const WPROJ_B = `proj_w_${WRUN}_b`;
  const WCHAN_A = `ch-a-${WRUN}`;
  const WCHAN_B = `ch-b-${WRUN}`;

  beforeEach(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, WSERVER));
  });

  afterAll(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, WSERVER));
  });

  it('enableWidget creates one row per (serverId, channelId)', async () => {
    const a = await enableWidget(WSERVER, { name: 'Moddio', channelId: WCHAN_A, workspaceProjectId: WPROJ_A });
    const b = await enableWidget(WSERVER, { name: 'Snek',   channelId: WCHAN_B, workspaceProjectId: WPROJ_B });
    expect(a.id).not.toBe(b.id);
    expect(a.channelId).toBe(WCHAN_A);
    expect(b.channelId).toBe(WCHAN_B);
    expect(a.workspaceProjectId).toBe(WPROJ_A);
    expect(b.workspaceProjectId).toBe(WPROJ_B);
  });

  it('enableWidget for an existing (server, channel) re-enables and rotates secret without creating a duplicate row', async () => {
    const first  = await enableWidget(WSERVER, { name: 'Moddio', channelId: WCHAN_A, workspaceProjectId: WPROJ_A });
    const second = await enableWidget(WSERVER, { name: 'Moddio', channelId: WCHAN_A, workspaceProjectId: WPROJ_A });
    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);                    // slug preserved
    expect(second.apiSecretHash).not.toBe(first.apiSecretHash); // rotated
    const all = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, WSERVER));
    expect(all).toHaveLength(1);
  });

  it('enableWidget works without workspaceProjectId (channel-only path)', async () => {
    // Phase 5: workspaceProjectId is optional. Re-enable on the same channel
    // still preserves the slug + finds the existing row.
    const first  = await enableWidget(WSERVER, { name: 'NoProj', channelId: WCHAN_A });
    expect(first.workspaceProjectId).toBeNull();
    const second = await enableWidget(WSERVER, { name: 'NoProj', channelId: WCHAN_A });
    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
  });

  it('enableWidget rejects calls without channelId', async () => {
    await expect(
      enableWidget(WSERVER, { name: 'X' } as any),
    ).rejects.toThrow(/channelId/);
  });

  it('disableWidget(serverId, {channelId}) does not affect a sibling channel on the same server', async () => {
    await enableWidget(WSERVER, { name: 'Moddio', channelId: WCHAN_A, workspaceProjectId: WPROJ_A });
    await enableWidget(WSERVER, { name: 'Snek',   channelId: WCHAN_B, workspaceProjectId: WPROJ_B });
    await disableWidget(WSERVER, { channelId: WCHAN_A });
    const a = await getWidgetIntegration(WSERVER, { channelId: WCHAN_A });
    const b = await getWidgetIntegration(WSERVER, { channelId: WCHAN_B });
    expect(a).toBeNull();   // disabled = enabled:false; getWidgetIntegration filters enabled=true
    expect(b?.name).toBe('Snek');
  });

  it('updateWidgetSettings only updates the targeted channel row', async () => {
    await enableWidget(WSERVER, { name: 'Moddio', channelId: WCHAN_A, workspaceProjectId: WPROJ_A });
    await enableWidget(WSERVER, { name: 'Snek',   channelId: WCHAN_B, workspaceProjectId: WPROJ_B });
    // login_url is required when is_public=true (validated by updateWidgetSettings).
    await updateWidgetSettings(
      WSERVER,
      { is_public: true, login_url: 'https://example.com/login' },
      { channelId: WCHAN_A },
    );
    const a = await getWidgetSettings(WSERVER, { channelId: WCHAN_A });
    const b = await getWidgetSettings(WSERVER, { channelId: WCHAN_B });
    expect(a?.is_public).toBe(true);
    expect(b?.is_public).toBe(false);
  });
});

// ============================================================================
// Reconcile tests (Pass 1 + Pass 2)
// ============================================================================

describe('reconcileWidgetBindings — Pass 1 (workspace_project_id backfill from channel map)', () => {
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

    const result = await reconcileWidgetBindings(RSERVER, {
      channelToProject: { [KNOWN_CHANNEL]: RPROJ },
      projectToPrimaryTodoChannel: {},
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

    const result = await reconcileWidgetBindings(RSERVER, {
      channelToProject: { [`ch_other_${RRUN}`]: RPROJ },
      projectToPrimaryTodoChannel: {},
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

    const result = await reconcileWidgetBindings(RSERVER, {
      channelToProject: { [KNOWN_CHANNEL]: `proj_DIFFERENT_${RRUN}` }, // ignored, row already populated
      projectToPrimaryTodoChannel: {},
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

    const result = await reconcileWidgetBindings(RSERVER, {
      channelToProject: { [KNOWN_CHANNEL]: RPROJ },
      projectToPrimaryTodoChannel: {},
    });
    expect(result.updated).toBe(0);
  });
});

// ============================================================================
// Reconcile Pass 2 + mixed tests
// ============================================================================

describe('reconcileWidgetBindings — Pass 2 (channel_id backfill from project map)', () => {
  const BRUN = randomBytes(6).toString('hex');
  const BSERVER = `ws_bind_${BRUN}`;
  const BPROJ_X = `proj_bind_${BRUN}_x`;
  const BPROJ_Y = `proj_bind_${BRUN}_y`;
  const BCHAN_X = `ch_bind_${BRUN}_x`;

  beforeEach(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, BSERVER));
  });

  afterAll(async () => {
    await db.delete(widgetProjects).where(eq(widgetProjects.serverId, BSERVER));
  });

  it('fills channel_id for rows with workspace_project_id set but channel_id NULL', async () => {
    await db.insert(widgetProjects).values({
      serverId: BSERVER,
      workspaceProjectId: BPROJ_X,
      // channel_id intentionally NULL.
      name: 'PassTwo', slug: `pass2-${BRUN}`,
      apiKey: `k-${BRUN}`, apiSecretHash: `s-${BRUN}`,
      enabled: true, channelId: null,
    });

    const result = await reconcileWidgetBindings(BSERVER, {
      channelToProject: {},
      projectToPrimaryTodoChannel: { [BPROJ_X]: BCHAN_X },
    });
    expect(result.updated).toBe(1);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, BSERVER));
    expect(row.channelId).toBe(BCHAN_X);
    expect(row.workspaceProjectId).toBe(BPROJ_X);
  });

  it('leaves channel_id NULL when no matching primary-todo entry exists', async () => {
    await db.insert(widgetProjects).values({
      serverId: BSERVER,
      workspaceProjectId: BPROJ_Y,
      name: 'NoMatch', slug: `nomatch-${BRUN}`,
      apiKey: `k-${BRUN}`, apiSecretHash: `s-${BRUN}`,
      enabled: true, channelId: null,
    });

    const result = await reconcileWidgetBindings(BSERVER, {
      channelToProject: {},
      projectToPrimaryTodoChannel: {}, // no entry for BPROJ_Y
    });
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, BSERVER));
    expect(row.channelId).toBeNull();
    expect(row.workspaceProjectId).toBe(BPROJ_Y);
  });

  it('leaves orphan rows (both channel_id and workspace_project_id NULL) untouched', async () => {
    // Phase 4 migration surfaces these for manual triage; the reconciler
    // intentionally cannot resolve them from either direction.
    await db.insert(widgetProjects).values({
      serverId: BSERVER,
      workspaceProjectId: null,
      channelId: null,
      name: 'Orphan', slug: `orphan-${BRUN}`,
      apiKey: `k-${BRUN}`, apiSecretHash: `s-${BRUN}`,
      enabled: true,
    });

    const result = await reconcileWidgetBindings(BSERVER, {
      channelToProject: { someChan: 'someProj' },
      projectToPrimaryTodoChannel: { someProj: 'someChan' },
    });
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, BSERVER));
    expect(row.workspaceProjectId).toBeNull();
    expect(row.channelId).toBeNull();
  });

  it('Pass 1 and Pass 2 both fire on distinct rows in one reconcile call', async () => {
    const PROJ_A = `proj_mix_${BRUN}_a`;
    const CHAN_A = `ch_mix_${BRUN}_a`;
    const PROJ_B = `proj_mix_${BRUN}_b`;
    const CHAN_B = `ch_mix_${BRUN}_b`;

    // Row A: project set, channel NULL → Pass 2 should fill channel.
    // Row B: channel set, project NULL → Pass 1 should fill project.
    const inserted = await db.insert(widgetProjects).values([
      {
        serverId: BSERVER,
        workspaceProjectId: PROJ_A,
        channelId: null,
        name: 'MixA', slug: `mixa-${BRUN}`,
        apiKey: `kA-${BRUN}`, apiSecretHash: `sA-${BRUN}`, enabled: true,
      },
      {
        serverId: BSERVER,
        workspaceProjectId: null,
        channelId: CHAN_B,
        name: 'MixB', slug: `mixb-${BRUN}`,
        apiKey: `kB-${BRUN}`, apiSecretHash: `sB-${BRUN}`, enabled: true,
      },
    ]).returning({ id: widgetProjects.id, slug: widgetProjects.slug });

    const result = await reconcileWidgetBindings(BSERVER, {
      channelToProject: { [CHAN_B]: PROJ_B },
      projectToPrimaryTodoChannel: { [PROJ_A]: CHAN_A },
    });
    expect(result.updated).toBe(2);

    const rows = await db.select().from(widgetProjects).where(eq(widgetProjects.serverId, BSERVER));
    const bySlug = new Map(rows.map(r => [r.slug, r]));
    const rowA = bySlug.get(`mixa-${BRUN}`)!;
    const rowB = bySlug.get(`mixb-${BRUN}`)!;
    expect(rowA.workspaceProjectId).toBe(PROJ_A);
    expect(rowA.channelId).toBe(CHAN_A);
    expect(rowB.workspaceProjectId).toBe(PROJ_B);
    expect(rowB.channelId).toBe(CHAN_B);
    // Silence unused warning for `inserted`; helps if we want to debug later.
    expect(inserted).toHaveLength(2);
  });
});
