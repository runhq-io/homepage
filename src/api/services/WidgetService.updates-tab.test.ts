import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects } from '../../db/schema';
import { listDoneTickets } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_ut_test_${RUN_HEX}`;
const USER_ID = `00000000-0002-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Updates Test ${RUN_HEX}`,
    slug: `updates-test-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`,
    apiSecretHash: `secret-${RUN_HEX}`,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  if (!project) throw new Error('seed failed');
  PROJECT_ID = project.id;

  const now = Date.now();
  await db.insert(workspaceTasks).values([
    { serverId: SERVER_ID, title: 'Done 1 (oldest)',    status: 'done',        visibility: 'public', completedAt: new Date(now - 3000) },
    { serverId: SERVER_ID, title: 'Done 2 (newest)',    status: 'done',        visibility: 'public', completedAt: new Date(now - 1000) },
    { serverId: SERVER_ID, title: 'Done 3 (mid)',       status: 'done',        visibility: 'public', completedAt: new Date(now - 2000) },
    { serverId: SERVER_ID, title: 'Open',               status: 'in_progress', visibility: 'public' },
    { serverId: SERVER_ID, title: 'Cancelled',          status: 'cancelled',   visibility: 'public' },
    { serverId: SERVER_ID, title: 'Private done',       status: 'done',        visibility: 'private', completedAt: new Date(now - 500) },
  ]);
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
});

describe('listDoneTickets', () => {
  it('returns only done + public tickets', async () => {
    const result = await listDoneTickets(PROJECT_ID);
    const titles = result.tickets.map(t => t.title);
    expect(titles).toContain('Done 1 (oldest)');
    expect(titles).toContain('Done 2 (newest)');
    expect(titles).toContain('Done 3 (mid)');
    expect(titles).not.toContain('Open');
    expect(titles).not.toContain('Cancelled');
    expect(titles).not.toContain('Private done');
  });

  it('sorts by completedAt descending', async () => {
    const result = await listDoneTickets(PROJECT_ID);
    const doneTitles = result.tickets.map(t => t.title);
    expect(doneTitles[0]).toBe('Done 2 (newest)');
    expect(doneTitles[1]).toBe('Done 3 (mid)');
    expect(doneTitles[2]).toBe('Done 1 (oldest)');
  });

  it('returns the same envelope shape as listTickets', async () => {
    const result = await listDoneTickets(PROJECT_ID);
    expect(result).toHaveProperty('projectName');
    expect(result).toHaveProperty('projectSlug');
    expect(result).toHaveProperty('homepageUrl');
    expect(result).toHaveProperty('isIdentified');
    expect(result).toHaveProperty('tickets');
    expect(result.isIdentified).toBe(false);
  });

  it('sets isIdentified=true when widgetUserId is provided', async () => {
    const result = await listDoneTickets(PROJECT_ID, 'fake-widget-user-id');
    expect(result.isIdentified).toBe(true);
  });
});
