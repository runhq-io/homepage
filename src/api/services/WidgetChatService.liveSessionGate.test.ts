/**
 * Live-session read gate: a non-`live_coder` reader (the ticket reporter) must
 * never receive Live-session relay rows (staff↔coder + mirrored coder activity)
 * even for a ticket they own. Only `live_coder` staff see them. Runs against the
 * scratch Postgres.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, widgetProjects, widgetUsers, widgetChatConversations, widgetChatMessages } from '../../db/schema';
import * as WidgetChatService from './WidgetChatService';
import type { WidgetPermission } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_lsg_${RUN_HEX}`;
const USER_ID = `00000000-0011-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let OWNER_ID: string; // the reporter (owns the conversation)
let OTHER_ID: string; // a different widget user (staff)

const perms = (...p: WidgetPermission[]): ReadonlySet<WidgetPermission> => new Set(p);

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `lsg+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `LSG ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, workspaceProjectId: `wsp_lsg_${RUN_HEX}`, name: `LSG ${RUN_HEX}`,
    slug: `lsg-${RUN_HEX}`, apiKey: `apikey-lsg-${RUN_HEX}`, apiSecretHash: `secret-lsg-${RUN_HEX}`, channelId: `ch_lsg_${RUN_HEX}`,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [owner] = await db.insert(widgetUsers).values({ projectId: PROJECT_ID, externalUserId: `owner-${RUN_HEX}`, name: 'Reporter' }).returning({ id: widgetUsers.id });
  OWNER_ID = owner!.id;
  const [other] = await db.insert(widgetUsers).values({ projectId: PROJECT_ID, externalUserId: `staff-${RUN_HEX}`, name: 'Staff' }).returning({ id: widgetUsers.id });
  OTHER_ID = other!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
});

/** A ticket-linked conversation owned by the reporter, with one intake row and two live-session rows. */
async function seedTicketConversation() {
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: OWNER_ID, createdTaskId: randomUUID(), status: 'closed',
  }).returning();
  await db.insert(widgetChatMessages).values([
    { conversationId: conv!.id, role: 'user', content: 'my intake message', liveSession: false },
    { conversationId: conv!.id, role: 'user', content: 'staff steering the coder', liveSession: true },
    { conversationId: conv!.id, role: 'agent', content: 'coder progress update', liveSession: true },
  ]);
  return conv!;
}

describe('listMessages live-session gate', () => {
  it('the reporter (owner, no live_coder) sees ONLY their intake — never the live-session rows', async () => {
    const conv = await seedTicketConversation();
    const rows = await WidgetChatService.listMessages(conv.id, PROJECT_ID, OWNER_ID, perms('view_tickets', 'voter', 'ticket_creator'));
    expect(rows.map((r) => r.content)).toEqual(['my intake message']);
    expect(rows.some((r) => r.liveSession)).toBe(false);
  });

  it('a live_coder staff member (non-owner) sees the full transcript incl. live-session rows', async () => {
    const conv = await seedTicketConversation();
    const rows = await WidgetChatService.listMessages(conv.id, PROJECT_ID, OTHER_ID, perms('live_coder', 'assign_agent'));
    expect(rows.map((r) => r.content).sort()).toEqual([
      'coder progress update', 'my intake message', 'staff steering the coder',
    ]);
  });

  it('the owner WITH live_coder also sees everything (permission, not ownership, unlocks it)', async () => {
    const conv = await seedTicketConversation();
    const rows = await WidgetChatService.listMessages(conv.id, PROJECT_ID, OWNER_ID, perms('live_coder'));
    expect(rows.length).toBe(3);
  });

  it('a non-owner WITHOUT live_coder cannot read the conversation at all (404)', async () => {
    const conv = await seedTicketConversation();
    await expect(
      WidgetChatService.listMessages(conv.id, PROJECT_ID, OTHER_ID, perms('view_tickets')),
    ).rejects.toMatchObject({ status: 404 });
  });
});
