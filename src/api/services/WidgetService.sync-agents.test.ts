import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetExposedAgents,
} from '../../db/schema';
import { syncWidgetExposedAgents } from './WidgetService';

const RUN = randomBytes(6).toString('hex');
// Use a separate 12-char hex suffix for the UUID fields (must be valid hex)
const RUN12 = randomBytes(6).toString('hex'); // exactly 12 hex chars

// Two users and two servers; each server has one widget project with a
// workspaceProjectId so the sync function can locate the row.
const USER_A = `00000000-aa00-4000-a000-${RUN12}`;
const USER_B = `00000000-bb00-4000-b000-${RUN12}`;
const SERVER_A = `ws_sync_a_${RUN}`;
const SERVER_B = `ws_sync_b_${RUN}`;

// Workspace project IDs (the IDs that exist in the workspace, mirrored here)
const WP_ID_A = `wsproj_sync_a_${RUN}`;
const WP_ID_B = `wsproj_sync_b_${RUN}`;

// widget_projects row IDs returned after insert
let WP_ROW_A: string;
let WP_ROW_B: string;

beforeAll(async () => {
  await db
    .insert(users)
    .values([
      { id: USER_A, email: `sync_a+${RUN}@test.invalid`, name: 'SyncA' },
      { id: USER_B, email: `sync_b+${RUN}@test.invalid`, name: 'SyncB' },
    ])
    .onConflictDoNothing();

  await db
    .insert(servers)
    .values([
      { id: SERVER_A, name: `SyncSrv A ${RUN}`, ownerId: USER_A },
      { id: SERVER_B, name: `SyncSrv B ${RUN}`, ownerId: USER_B },
    ])
    .onConflictDoNothing();

  const projects = await db
    .insert(widgetProjects)
    .values([
      {
        serverId: SERVER_A,
        workspaceProjectId: WP_ID_A,
        name: `Sync A ${RUN}`,
        slug: `sync-a-${RUN}`,
        apiKey: `apikey-sync-a-${RUN}`,
        apiSecretHash: `secret-sync-a-${RUN}`,
        enabled: true,
      },
      {
        serverId: SERVER_B,
        workspaceProjectId: WP_ID_B,
        name: `Sync B ${RUN}`,
        slug: `sync-b-${RUN}`,
        apiKey: `apikey-sync-b-${RUN}`,
        apiSecretHash: `secret-sync-b-${RUN}`,
        enabled: true,
      },
    ])
    .returning({ id: widgetProjects.id, serverId: widgetProjects.serverId });

  WP_ROW_A = projects.find((p) => p.serverId === SERVER_A)!.id;
  WP_ROW_B = projects.find((p) => p.serverId === SERVER_B)!.id;
});

afterAll(async () => {
  await db
    .delete(widgetExposedAgents)
    .where(inArray(widgetExposedAgents.widgetProjectId, [WP_ROW_A, WP_ROW_B]));
  await db
    .delete(widgetProjects)
    .where(inArray(widgetProjects.id, [WP_ROW_A, WP_ROW_B]));
  await db.delete(servers).where(inArray(servers.id, [SERVER_A, SERVER_B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
});

// Helper to read the agents for a widget_project row (by widget_projects.id)
async function readAgents(widgetProjectId: string) {
  return db
    .select({
      agentId: widgetExposedAgents.agentId,
      agentName: widgetExposedAgents.agentName,
      agentDescription: widgetExposedAgents.agentDescription,
    })
    .from(widgetExposedAgents)
    .where(eq(widgetExposedAgents.widgetProjectId, widgetProjectId))
    .orderBy(widgetExposedAgents.agentId);
}

// Seed helper — bypasses the service so tests start from a known state
async function seedAgents(
  widgetProjectId: string,
  agents: Array<{ id: string; name: string; description?: string | null }>,
) {
  if (agents.length === 0) return;
  await db.insert(widgetExposedAgents).values(
    agents.map((a) => ({
      widgetProjectId,
      agentId: a.id,
      agentName: a.name,
      agentDescription: a.description ?? null,
    })),
  ).onConflictDoNothing();
}

// Clear agents directly (setup hygiene between tests)
async function clearAgents(widgetProjectId: string) {
  await db
    .delete(widgetExposedAgents)
    .where(eq(widgetExposedAgents.widgetProjectId, widgetProjectId));
}

describe('syncWidgetExposedAgents', () => {
  it('full-replaces Project A agents while leaving Project B untouched', async () => {
    // Seed: Project A has 2 old agents, Project B has 1
    await clearAgents(WP_ROW_A);
    await clearAgents(WP_ROW_B);
    await seedAgents(WP_ROW_A, [
      { id: 'old-agent-1', name: 'Old One' },
      { id: 'old-agent-2', name: 'Old Two' },
    ]);
    await seedAgents(WP_ROW_B, [{ id: 'b-agent-1', name: 'B Agent One' }]);

    // Sync only Project A with 1 new agent
    const result = await syncWidgetExposedAgents(SERVER_A, [
      {
        workspaceProjectId: WP_ID_A,
        agents: [{ id: 'new-agent-1', name: 'New One', description: 'handles new' }],
      },
    ]);

    // Project A: only new agent remains
    const aAgents = await readAgents(WP_ROW_A);
    expect(aAgents).toHaveLength(1);
    expect(aAgents[0].agentId).toBe('new-agent-1');
    expect(aAgents[0].agentName).toBe('New One');
    expect(aAgents[0].agentDescription).toBe('handles new');

    // Project B: untouched
    const bAgents = await readAgents(WP_ROW_B);
    expect(bAgents).toHaveLength(1);
    expect(bAgents[0].agentId).toBe('b-agent-1');

    // Count: upserted = 1 new agent inserted, removed = 2 old agents deleted
    expect(result.upserted).toBe(1);
    expect(result.removed).toBe(2);
  });

  it('clears all agents when project sends an empty agents array', async () => {
    await clearAgents(WP_ROW_A);
    await seedAgents(WP_ROW_A, [
      { id: 'agt-x', name: 'X' },
      { id: 'agt-y', name: 'Y' },
    ]);

    const result = await syncWidgetExposedAgents(SERVER_A, [
      { workspaceProjectId: WP_ID_A, agents: [] },
    ]);

    const agents = await readAgents(WP_ROW_A);
    expect(agents).toHaveLength(0);
    // upserted = 0 (nothing inserted), removed = 2
    expect(result.upserted).toBe(0);
    expect(result.removed).toBe(2);
  });

  it('silently skips projects that have no widget_projects row', async () => {
    const NO_SUCH_WP = `wsproj_nonexistent_${RUN}`;

    const result = await syncWidgetExposedAgents(SERVER_A, [
      {
        workspaceProjectId: NO_SUCH_WP,
        agents: [{ id: 'phantom-agent', name: 'Phantom', description: null }],
      },
    ]);

    // Nothing was upserted or removed; no error thrown
    expect(result.upserted).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('counts upserted and removed correctly across multiple projects', async () => {
    await clearAgents(WP_ROW_A);
    await clearAgents(WP_ROW_B);

    // Seed: A has 3 agents, B has 0
    await seedAgents(WP_ROW_A, [
      { id: 'a1', name: 'A1' },
      { id: 'a2', name: 'A2' },
      { id: 'a3', name: 'A3' },
    ]);

    // Sync: A gets 2 new agents, B gets 1 new agent
    const result = await syncWidgetExposedAgents(SERVER_A, [
      {
        workspaceProjectId: WP_ID_A,
        agents: [
          { id: 'a-new-1', name: 'A New 1', description: null },
          { id: 'a-new-2', name: 'A New 2', description: 'desc' },
        ],
      },
    ]);

    // A: 2 new agents inserted, 3 old removed
    const aAgents = await readAgents(WP_ROW_A);
    expect(aAgents).toHaveLength(2);
    expect(aAgents.map((a) => a.agentId).sort()).toEqual(['a-new-1', 'a-new-2']);

    expect(result.upserted).toBe(2);
    expect(result.removed).toBe(3);
  });

  it('handles description=null and description=undefined identically (stores null)', async () => {
    await clearAgents(WP_ROW_A);

    await syncWidgetExposedAgents(SERVER_A, [
      {
        workspaceProjectId: WP_ID_A,
        agents: [
          { id: 'desc-null', name: 'Null Desc', description: null },
          { id: 'desc-undef', name: 'Undef Desc', description: undefined as any },
        ],
      },
    ]);

    const agents = await readAgents(WP_ROW_A);
    expect(agents).toHaveLength(2);
    for (const a of agents) {
      expect(a.agentDescription).toBeNull();
    }
  });
});
