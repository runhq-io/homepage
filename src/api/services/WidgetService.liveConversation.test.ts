/**
 * WidgetService.liveConversation.test.ts — integration coverage for
 * ensureTicketLiveConversation (the Live-session relay container for tickets
 * that were assigned a coder directly, not via a chat conversation).
 *
 * Self-contained setup (channelId set) so it runs regardless of whether the
 * scratch DB has widget_projects.channel_id nullable or NOT NULL.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects, widgetUsers, widgetChatConversations } from '../../db/schema';
import { ensureTicketLiveConversation, ensureLiveConversationForServerTask } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_lc_test_${RUN_HEX}`;
const OTHER_SERVER_ID = `ws_lc_other_${RUN_HEX}`;
const USER_ID = `00000000-000a-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-lc-${RUN_HEX}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+lc+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv LC ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  await db.insert(servers).values({ id: OTHER_SERVER_ID, name: `Srv LC other ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `LiveConvo Test ${RUN_HEX}`,
    slug: `live-convo-${RUN_HEX}`,
    apiKey: `apikey-lc-${RUN_HEX}`,
    apiSecretHash: `secret-lc-${RUN_HEX}`,
    channelId: CHANNEL_ID,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-lc-${RUN_HEX}`, name: 'Staff',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, OTHER_SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function makeTask(serverId: string) {
  const [task] = await db.insert(workspaceTasks).values({
    serverId,
    workspaceChannelId: CHANNEL_ID,
    title: 'Directly assigned ticket',
    visibility: 'public',
    status: 'in_progress',
    // External reporter — the widget user who filed it (owner of any
    // coder-created live conversation).
    createdByType: 'external',
    createdById: WIDGET_USER_ID,
  }).returning({ id: workspaceTasks.id });
  return task!.id;
}

describe('ensureLiveConversationForServerTask (coder post-to-widget resolution)', () => {
  it('creates a conversation owned by the ticket reporter, idempotently', async () => {
    const id = await makeTask(SERVER_ID);
    try {
      const first = await ensureLiveConversationForServerTask(SERVER_ID, id);
      expect(first).not.toBeNull();
      const [row] = await db
        .select({ createdTaskId: widgetChatConversations.createdTaskId, widgetUserId: widgetChatConversations.widgetUserId })
        .from(widgetChatConversations)
        .where(eq(widgetChatConversations.id, first!.conversationId));
      expect(row?.createdTaskId).toBe(id);
      expect(row?.widgetUserId).toBe(WIDGET_USER_ID);

      const second = await ensureLiveConversationForServerTask(SERVER_ID, id);
      expect(second!.conversationId).toBe(first!.conversationId);
    } finally {
      await db.delete(widgetChatConversations).where(eq(widgetChatConversations.createdTaskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('returns null for a task that is not on this server', async () => {
    const id = await makeTask(OTHER_SERVER_ID);
    try {
      expect(await ensureLiveConversationForServerTask(SERVER_ID, id)).toBeNull();
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });
});

describe('ensureTicketLiveConversation', () => {
  it('creates a conversation linked to the ticket and is idempotent', async () => {
    const id = await makeTask(SERVER_ID);
    try {
      const first = await ensureTicketLiveConversation(PROJECT_ID, id, WIDGET_USER_ID);
      expect(first).not.toBeNull();
      expect(first!.conversationId).toBeTruthy();

      // The conversation is linked to the ticket via createdTaskId.
      const [row] = await db
        .select({ createdTaskId: widgetChatConversations.createdTaskId })
        .from(widgetChatConversations)
        .where(eq(widgetChatConversations.id, first!.conversationId));
      expect(row?.createdTaskId).toBe(id);

      // Second call reuses the same conversation (no duplicate).
      const second = await ensureTicketLiveConversation(PROJECT_ID, id, WIDGET_USER_ID);
      expect(second!.conversationId).toBe(first!.conversationId);

      const all = await db
        .select({ id: widgetChatConversations.id })
        .from(widgetChatConversations)
        .where(eq(widgetChatConversations.createdTaskId, id));
      expect(all.length).toBe(1);
    } finally {
      await db.delete(widgetChatConversations).where(eq(widgetChatConversations.createdTaskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('reuses an existing chat-originated conversation instead of creating a new one', async () => {
    const id = await makeTask(SERVER_ID);
    const [pre] = await db.insert(widgetChatConversations).values({
      widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID, createdTaskId: id,
    }).returning({ id: widgetChatConversations.id });
    try {
      const result = await ensureTicketLiveConversation(PROJECT_ID, id, WIDGET_USER_ID);
      expect(result!.conversationId).toBe(pre!.id);
    } finally {
      await db.delete(widgetChatConversations).where(eq(widgetChatConversations.createdTaskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('returns null for a ticket that is not in this project (wrong server)', async () => {
    const id = await makeTask(OTHER_SERVER_ID);
    try {
      const result = await ensureTicketLiveConversation(PROJECT_ID, id, WIDGET_USER_ID);
      expect(result).toBeNull();
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });
});
