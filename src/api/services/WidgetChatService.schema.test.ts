/**
 * Schema-level guarantees for the widget chat tables: contract defaults,
 * jsonb payload round-trip, the (turn_id, seq) partial unique idempotency
 * index, cascade behavior, and the widget_projects chat columns. Runs
 * against the scratch Postgres (schema applied via `pnpm db:push`).
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  widgetChatConversations,
  widgetChatMessages,
} from '../../db/schema';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_chatschema_${RUN_HEX}`;
const USER_ID = `00000000-000a-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `cs+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatSchema ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_chatschema_${RUN_HEX}`,
    name: `ChatSchema ${RUN_HEX}`,
    slug: `chatschema-${RUN_HEX}`,
    apiKey: `apikey-cs-${RUN_HEX}`,
    apiSecretHash: `secret-cs-${RUN_HEX}`,
    channelId: `ch_cs_${RUN_HEX}`,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-cs-${RUN_HEX}`, name: 'Schema User',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  // Conversations + messages cascade from the project delete.
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function seedConversation() {
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID,
  }).returning();
  return conv!;
}

describe('widget_chat tables', () => {
  it('round-trips a conversation with contract defaults', async () => {
    const conv = await seedConversation();
    expect(conv).toMatchObject({
      widgetProjectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      status: 'active',
      createdTaskId: null,
      userTurnCount: 0,
      pendingTurnId: null,
    });
    expect(conv.createdAt).toBeInstanceOf(Date);
    expect(conv.updatedAt).toBeInstanceOf(Date);
  });

  it('round-trips messages incl. jsonb payload and turn metadata', async () => {
    const conv = await seedConversation();
    const turnId = randomUUID();
    const [msg] = await db.insert(widgetChatMessages).values({
      conversationId: conv.id,
      role: 'event',
      payload: { kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' },
      turnId,
      seq: 0,
    }).returning();
    expect(msg).toMatchObject({ role: 'event', content: '', turnId, seq: 0 });
    expect(msg!.payload).toEqual({ kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' });
  });

  it('enforces the (turn_id, seq) partial unique index via onConflictDoNothing', async () => {
    const conv = await seedConversation();
    const turnId = randomUUID();
    const values = { conversationId: conv.id, role: 'agent' as const, content: 'hi', turnId, seq: 0 };
    const first = await db.insert(widgetChatMessages).values(values).onConflictDoNothing().returning();
    const second = await db.insert(widgetChatMessages).values(values).onConflictDoNothing().returning();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('exempts turn_id-null rows from the index (user rows / BE notices)', async () => {
    const conv = await seedConversation();
    const a = await db.insert(widgetChatMessages).values({
      conversationId: conv.id, role: 'user', content: 'a', turnId: null, seq: 0,
    }).onConflictDoNothing().returning();
    const b = await db.insert(widgetChatMessages).values({
      conversationId: conv.id, role: 'user', content: 'b', turnId: null, seq: 0,
    }).onConflictDoNothing().returning();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('cascades: deleting a conversation removes its messages', async () => {
    const conv = await seedConversation();
    await db.insert(widgetChatMessages).values({ conversationId: conv.id, role: 'user', content: 'bye' });
    await db.delete(widgetChatConversations).where(eq(widgetChatConversations.id, conv.id));
    const orphans = await db.select().from(widgetChatMessages)
      .where(eq(widgetChatMessages.conversationId, conv.id));
    expect(orphans).toEqual([]);
  });

  it('widget_projects chat columns default to null and persist values', async () => {
    const [before] = await db
      .select({
        agent: widgetProjects.widgetChatAgentEntityId,
        instructions: widgetProjects.widgetChatInstructions,
      })
      .from(widgetProjects)
      .where(eq(widgetProjects.id, PROJECT_ID));
    expect(before).toEqual({ agent: null, instructions: null });

    await db.update(widgetProjects)
      .set({ widgetChatAgentEntityId: 'ae_support', widgetChatInstructions: 'Be kind.' })
      .where(eq(widgetProjects.id, PROJECT_ID));
    const [after] = await db
      .select({
        agent: widgetProjects.widgetChatAgentEntityId,
        instructions: widgetProjects.widgetChatInstructions,
      })
      .from(widgetProjects)
      .where(eq(widgetProjects.id, PROJECT_ID));
    expect(after).toEqual({ agent: 'ae_support', instructions: 'Be kind.' });
  });
});
