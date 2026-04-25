import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects } from '../../db/schema';
import { listTickets } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_pt_test_${RUN_HEX}`;
const USER_ID = `00000000-0003-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Pending Test ${RUN_HEX}`,
    slug: `pending-test-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`,
    apiSecretHash: `secret-${RUN_HEX}`,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  if (!project) throw new Error('seed failed');
  PROJECT_ID = project.id;

  const now = Date.now();
  await db.insert(workspaceTasks).values([
    { serverId: SERVER_ID, title: 'Pending ticket',     status: 'pending',     visibility: 'public' },
    { serverId: SERVER_ID, title: 'Planned ticket',     status: 'planned',     visibility: 'public' },
    { serverId: SERVER_ID, title: 'In progress ticket', status: 'in_progress', visibility: 'public' },
    { serverId: SERVER_ID, title: 'Needs review ticket', status: 'needs_review', visibility: 'public' },
    { serverId: SERVER_ID, title: 'Shipped ticket',     status: 'done',        visibility: 'public', completedAt: new Date(now - 1000) },
    { serverId: SERVER_ID, title: 'Deployed ticket',    status: 'deployed',    visibility: 'public', completedAt: new Date(now - 500) },
    { serverId: SERVER_ID, title: 'Cancelled ticket',   status: 'cancelled',   visibility: 'public' },
  ]);
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('listTickets (Pending tab)', () => {
  it('excludes done, deployed, and cancelled tickets', async () => {
    const result = await listTickets(PROJECT_ID);
    const titles = result.tickets.map(t => t.title);

    expect(titles).toContain('Pending ticket');
    expect(titles).toContain('Planned ticket');
    expect(titles).toContain('In progress ticket');
    expect(titles).toContain('Needs review ticket');

    expect(titles).not.toContain('Shipped ticket');
    expect(titles).not.toContain('Deployed ticket');
    expect(titles).not.toContain('Cancelled ticket');
  });
});
