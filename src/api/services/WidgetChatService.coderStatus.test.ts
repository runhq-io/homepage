/**
 * Live-coder presence for widget live sessions:
 *  - applyCoderStatusInMemory / getCoderWorking / subscribeToCoderStatus — the
 *    pure in-memory transition core (publish-on-change, TTL self-expiry). No DB.
 *  - setCoderStatus — the authenticated entry point + cross-tenant guard, run
 *    against the scratch Postgres (skipped when DATABASE_URL is absent).
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as WidgetChatService from './WidgetChatService';

describe('applyCoderStatusInMemory / getCoderWorking / subscribeToCoderStatus', () => {
  it('publishes a frame + flips getCoderWorking only on a genuine transition', () => {
    const conv = randomUUID();
    const frames: boolean[] = [];
    const unsub = WidgetChatService.subscribeToCoderStatus(conv, (w) => frames.push(w));

    expect(WidgetChatService.getCoderWorking(conv)).toBe(false);

    WidgetChatService.applyCoderStatusInMemory(conv, true);
    expect(WidgetChatService.getCoderWorking(conv)).toBe(true);

    // Heartbeat (same value) → no new frame.
    WidgetChatService.applyCoderStatusInMemory(conv, true);
    expect(WidgetChatService.getCoderWorking(conv)).toBe(true);

    WidgetChatService.applyCoderStatusInMemory(conv, false);
    expect(WidgetChatService.getCoderWorking(conv)).toBe(false);

    // Redundant false → no extra frame.
    WidgetChatService.applyCoderStatusInMemory(conv, false);

    unsub();
    expect(frames).toEqual([true, false]);
  });

  it('self-expires to standing-by after the heartbeat TTL', () => {
    vi.useFakeTimers();
    try {
      const conv = randomUUID();
      const frames: boolean[] = [];
      const unsub = WidgetChatService.subscribeToCoderStatus(conv, (w) => frames.push(w));

      WidgetChatService.applyCoderStatusInMemory(conv, true);
      expect(WidgetChatService.getCoderWorking(conv)).toBe(true);

      // No further heartbeat → TTL fires, flips to standing-by.
      vi.advanceTimersByTime(60_000);
      expect(WidgetChatService.getCoderWorking(conv)).toBe(false);
      expect(frames).toEqual([true, false]);

      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a heartbeat re-arms the TTL (does not expire while heartbeats continue)', () => {
    vi.useFakeTimers();
    try {
      const conv = randomUUID();
      WidgetChatService.applyCoderStatusInMemory(conv, true);
      // Advance past the TTL in steps, re-asserting `working` before each expiry.
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(30_000);
        WidgetChatService.applyCoderStatusInMemory(conv, true); // heartbeat
      }
      expect(WidgetChatService.getCoderWorking(conv)).toBe(true);
      WidgetChatService.applyCoderStatusInMemory(conv, false); // clean up timer
    } finally {
      vi.useRealTimers();
    }
  });
});

// Cross-tenant guard needs the scratch Postgres — skipped when it isn't wired.
describe.skipIf(!process.env.DATABASE_URL)('setCoderStatus (cross-tenant guard)', () => {
  const RUN_HEX = randomBytes(6).toString('hex');
  const SERVER_ID = `ws_coderstatus_${RUN_HEX}`;
  const OTHER_SERVER_ID = `ws_coderstatus_other_${RUN_HEX}`;
  const USER_ID = `00000000-00cd-4000-a000-${RUN_HEX.padStart(12, '0')}`;
  let db: typeof import('../../db/index').db;
  let schema: typeof import('../../db/schema');
  let eq: typeof import('drizzle-orm').eq;
  let PROJECT_ID: string;
  let TASK_ID: string;
  let CONV_ID: string;

  beforeAll(async () => {
    ({ db } = await import('../../db/index'));
    schema = await import('../../db/schema');
    ({ eq } = await import('drizzle-orm'));
    await db.insert(schema.users).values({ id: USER_ID, email: `ci+cs${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
    await db.insert(schema.servers).values({ id: SERVER_ID, name: `CoderStatus ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
    await db.insert(schema.servers).values({ id: OTHER_SERVER_ID, name: `Other ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
    const [project] = await db.insert(schema.widgetProjects).values({
      serverId: SERVER_ID,
      workspaceProjectId: `wsp_cs_${RUN_HEX}`,
      name: `CoderStatus ${RUN_HEX}`,
      slug: `coderstatus-${RUN_HEX}`,
      apiKey: `apikey-cs-${RUN_HEX}`,
      apiSecretHash: `secret-cs-${RUN_HEX}`,
      channelId: `ch_cs_${RUN_HEX}`,
    }).returning({ id: schema.widgetProjects.id });
    PROJECT_ID = project!.id;
    const [wu] = await db.insert(schema.widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-cs-${RUN_HEX}`, name: 'Reporter',
    }).returning({ id: schema.widgetUsers.id });
    const [task] = await db.insert(schema.workspaceTasks).values({
      serverId: SERVER_ID, title: 'Live task', sourceType: 'widget', createdByType: 'external', visibility: 'public',
    }).returning({ id: schema.workspaceTasks.id });
    TASK_ID = task!.id;
    const [conv] = await db.insert(schema.widgetChatConversations).values({
      widgetProjectId: PROJECT_ID, widgetUserId: wu!.id, createdTaskId: TASK_ID,
    }).returning({ id: schema.widgetChatConversations.id });
    CONV_ID = conv!.id;
  });

  afterAll(async () => {
    if (CONV_ID) WidgetChatService.applyCoderStatusInMemory(CONV_ID, false);
    if (CONV_ID) await db.delete(schema.widgetChatConversations).where(eq(schema.widgetChatConversations.id, CONV_ID));
    if (TASK_ID) await db.delete(schema.workspaceTasks).where(eq(schema.workspaceTasks.id, TASK_ID));
    if (PROJECT_ID) await db.delete(schema.widgetProjects).where(eq(schema.widgetProjects.id, PROJECT_ID));
    await db.delete(schema.servers).where(eq(schema.servers.id, SERVER_ID));
    await db.delete(schema.servers).where(eq(schema.servers.id, OTHER_SERVER_ID));
    await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
  });

  it('accepts the owning server and rejects a cross-tenant server', async () => {
    await WidgetChatService.setCoderStatus(SERVER_ID, CONV_ID, true);
    expect(WidgetChatService.getCoderWorking(CONV_ID)).toBe(true);

    await expect(WidgetChatService.setCoderStatus(OTHER_SERVER_ID, CONV_ID, false))
      .rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
    // Rejected call must not mutate state.
    expect(WidgetChatService.getCoderWorking(CONV_ID)).toBe(true);
  });
});
