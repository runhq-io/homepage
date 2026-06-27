import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { servers, users, widgetProjects, widgetUsers, workspaceTasks } from '../../db/schema';
import * as InjectionGuardService from './InjectionGuardService';
import { createTicket, createTicketWithAttachments } from './WidgetService';

const RUN = randomBytes(6).toString('hex');
const USER_ID = `00000000-0005-4000-a000-${RUN.padStart(12, '0')}`;
const SERVER_ID = `ws_review_policy_${RUN}`;
const STORAGE_ENV = [
  'TASK_ATTACHMENT_STORAGE_PROVIDER',
  'TASK_ATTACHMENT_STORAGE_BUCKET',
  'TASK_ATTACHMENT_STORAGE_ENDPOINT',
  'TASK_ATTACHMENT_STORAGE_ACCESS_KEY_ID',
  'TASK_ATTACHMENT_STORAGE_SECRET_ACCESS_KEY',
] as const;
const ORIGINAL_STORAGE = new Map<string, string | undefined>(
  STORAGE_ENV.map((key) => [key, process.env[key]]),
);

let autoProjectId: string;
let humanProjectId: string;
let autoWidgetUserId: string;
let humanWidgetUserId: string;

beforeAll(async () => {
  await db.insert(users).values({
    id: USER_ID,
    email: `review-policy-${RUN}@test.invalid`,
    name: 'Review Policy',
  }).onConflictDoNothing();

  await db.insert(servers).values({
    id: SERVER_ID,
    name: `Review Policy ${RUN}`,
    ownerId: USER_ID,
  }).onConflictDoNothing();

  const [autoProject, humanProject] = await db.insert(widgetProjects).values([
    {
      serverId: SERVER_ID,
      name: `Auto Review ${RUN}`,
      slug: `auto-review-${RUN}`,
      apiKey: `auto-review-key-${RUN}`,
      apiSecretHash: `auto-review-secret-${RUN}`,
      enabled: true,
      widgetAgentAssignmentEnabled: true,
    },
    {
      serverId: SERVER_ID,
      name: `Human Review ${RUN}`,
      slug: `human-review-${RUN}`,
      apiKey: `human-review-key-${RUN}`,
      apiSecretHash: `human-review-secret-${RUN}`,
      enabled: true,
      widgetAgentAssignmentEnabled: false,
    },
  ]).returning({ id: widgetProjects.id });

  autoProjectId = autoProject!.id;
  humanProjectId = humanProject!.id;

  const [autoUser, humanUser] = await db.insert(widgetUsers).values([
    { projectId: autoProjectId, externalUserId: `auto-user-${RUN}`, name: 'Auto User' },
    { projectId: humanProjectId, externalUserId: `human-user-${RUN}`, name: 'Human User' },
  ]).returning({ id: widgetUsers.id });

  autoWidgetUserId = autoUser!.id;
  humanWidgetUserId = humanUser!.id;
});

beforeEach(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of STORAGE_ENV) {
    const value = ORIGINAL_STORAGE.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(inArray(widgetUsers.projectId, [autoProjectId, humanProjectId]));
  await db.delete(widgetProjects).where(inArray(widgetProjects.id, [autoProjectId, humanProjectId]));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('widget ticket review policy', () => {
  it('rejects text-only creation when auto-assignment is enabled and the guard is unavailable', async () => {
    vi.spyOn(InjectionGuardService, 'checkTicket').mockResolvedValue({
      safe: false,
      reasons: ['guard_unavailable'],
      unavailable: true,
    });

    await expect(
      createTicket(autoProjectId, autoWidgetUserId, {
        title: 'Checkout fails',
        description: 'The checkout button hangs.',
      }),
    ).rejects.toMatchObject({ code: 'ticket_review_unavailable', status: 503 });

    const rows = await db.select({ id: workspaceTasks.id }).from(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
    expect(rows).toHaveLength(0);
  });

  it('allows text-only creation without calling the guard when auto-assignment is disabled', async () => {
    const guard = vi.spyOn(InjectionGuardService, 'checkTicket').mockResolvedValue({
      safe: false,
      reasons: ['guard_unavailable'],
      unavailable: true,
    });

    const ticket = await createTicket(humanProjectId, humanWidgetUserId, {
      title: 'Human triage ticket',
      description: 'A person will review this.',
    });

    expect(ticket.id).toBeTruthy();
    expect(guard).not.toHaveBeenCalled();
  });

  it('rejects ticket-with-image creation when auto-assignment is enabled and image review is unavailable', async () => {
    process.env.TASK_ATTACHMENT_STORAGE_PROVIDER = 'r2';
    process.env.TASK_ATTACHMENT_STORAGE_BUCKET = 'bucket';
    process.env.TASK_ATTACHMENT_STORAGE_ENDPOINT = 'https://example.invalid';
    process.env.TASK_ATTACHMENT_STORAGE_ACCESS_KEY_ID = 'id';
    process.env.TASK_ATTACHMENT_STORAGE_SECRET_ACCESS_KEY = 'secret';
    vi.spyOn(InjectionGuardService, 'checkTicket').mockResolvedValue({
      safe: false,
      reasons: ['guard_unavailable'],
      unavailable: true,
    });

    await expect(
      createTicketWithAttachments(
        autoProjectId,
        autoWidgetUserId,
        { title: 'Screenshot issue', description: 'See attached.' },
        [{ buffer: Buffer.from('png'), mimeType: 'image/png', filename: 'screen.png' }],
      ),
    ).rejects.toMatchObject({ code: 'attachment_review_unavailable', status: 503 });

    const rows = await db.select({ id: workspaceTasks.id }).from(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
    expect(rows).toHaveLength(0);
  });
});
