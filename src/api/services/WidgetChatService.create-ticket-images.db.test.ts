/**
 * createTicketFromChat — chat image carry-over to task attachments.
 *
 * When a chat conversation becomes a ticket, all images in `widget_chat_images`
 * for that conversation must be linked as `workspaceTaskAttachments` rows with
 * ownerType='task', referencing the ORIGINAL storage object (no copy).
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  widgetClarifications,
  workspaceTasks,
  workspaceTaskAttachments,
  widgetChatConversations,
  widgetChatMessages,
  widgetChatImages,
} from '../../db/schema';
import * as WidgetChatService from './WidgetChatService';
import * as ServerService from './ServerService';

vi.mock('./ServerService', () => ({
  serverTokenFetch: vi.fn(),
}));

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_ctimg_${RUN_HEX}`;
const USER_ID = `00000000-000c-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `ctimg+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `CTImg ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_ctimg_${RUN_HEX}`,
    name: `CTImg ${RUN_HEX}`,
    slug: `ctimg-${RUN_HEX}`,
    apiKey: `apikey-ctimg-${RUN_HEX}`,
    apiSecretHash: `secret-ctimg-${RUN_HEX}`,
    channelId: `ch_ctimg_${RUN_HEX}`,
    widgetChatAgentEntityId: 'ae_support',
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-ctimg-${RUN_HEX}`, name: 'Image User',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetClarifications).where(eq(widgetClarifications.serverId, SERVER_ID));
  await db.delete(workspaceTaskAttachments).where(eq(workspaceTaskAttachments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

let CONV_ID: string;

beforeEach(async () => {
  vi.mocked(ServerService.serverTokenFetch).mockReset();
  vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({ ok: true } as any);
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID, userTurnCount: 2,
  }).returning();
  CONV_ID = conv!.id;
});

async function seedProposal(toolUseId = 'tu_img_create') {
  const [row] = await db.insert(widgetChatMessages).values({
    conversationId: CONV_ID, role: 'event',
    payload: { kind: 'proposal', title: 'Image ticket', description: 'See attached', toolUseId },
  }).returning();
  return row!;
}

async function seedChatImage(overrides: { storageKey?: string; originalName?: string | null } = {}) {
  const [img] = await db.insert(widgetChatImages).values({
    conversationId: CONV_ID,
    widgetUserId: WIDGET_USER_ID,
    serverId: SERVER_ID,
    mimeType: 'image/png',
    originalName: overrides.originalName ?? 'screenshot.png',
    originalStorageProvider: 'r2',
    originalStorageKey: overrides.storageKey ?? `uploads/test/${RUN_HEX}/${randomBytes(4).toString('hex')}.png`,
    modelStorageProvider: 'r2',
    modelStorageKey: `model/test/${RUN_HEX}/${randomBytes(4).toString('hex')}.jpg`,
    width: 800,
    height: 600,
  }).returning();
  return img!;
}

describe('createTicketFromChat — image attachment carry-over', () => {
  it('links N conversation images as task attachments with ownerType=task and ORIGINAL storage keys', async () => {
    await seedProposal();
    const img1 = await seedChatImage({ storageKey: `uploads/${RUN_HEX}/a.png` });
    const img2 = await seedChatImage({ storageKey: `uploads/${RUN_HEX}/b.png` });

    const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'Image ticket', description: 'See attached',
    });

    const attachments = await db
      .select()
      .from(workspaceTaskAttachments)
      .where(eq(workspaceTaskAttachments.taskId, ticketId));

    expect(attachments).toHaveLength(2);
    const keys = attachments.map((a) => a.storageKey).sort();
    expect(keys).toEqual([img1.originalStorageKey, img2.originalStorageKey].sort());

    for (const att of attachments) {
      expect(att.ownerType).toBe('task');
      expect(att.ownerId).toBe(ticketId);
      expect(att.serverId).toBe(SERVER_ID);
      expect(att.storageProvider).toBe('r2');
      expect(att.mimeType).toBe('image/png');
      expect(att.originalName).toBe('screenshot.png');
    }
  });

  it('creates the ticket successfully with no attachment inserts when the conversation has no images', async () => {
    await seedProposal('tu_no_images');

    const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'No image ticket', description: 'Plain text only',
    });

    const attachments = await db
      .select()
      .from(workspaceTaskAttachments)
      .where(eq(workspaceTaskAttachments.taskId, ticketId));

    expect(attachments).toHaveLength(0);

    // Ticket still created correctly
    const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, ticketId));
    expect(task).toMatchObject({ title: 'No image ticket', serverId: SERVER_ID });
  });

  it('uses the original storage key (not the model derivative key)', async () => {
    await seedProposal('tu_original_key');
    const img = await seedChatImage({ storageKey: `uploads/${RUN_HEX}/original.png` });

    const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'Key check', description: 'Check',
    });

    const [att] = await db
      .select()
      .from(workspaceTaskAttachments)
      .where(eq(workspaceTaskAttachments.taskId, ticketId));

    expect(att).toBeDefined();
    expect(att!.storageKey).toBe(img.originalStorageKey);
    // Must NOT be the model derivative key
    expect(att!.storageKey).not.toBe(img.modelStorageKey);
  });
});
