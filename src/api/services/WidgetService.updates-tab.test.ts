import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects } from '../../db/schema';
import { listPublishedTickets } from './WidgetService';

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
    // A: published + public + done (oldest) — must appear, proves status doesn't gate
    {
      serverId: SERVER_ID,
      title: 'A-done-oldest',
      status: 'done',
      visibility: 'public',
      isPublished: true,
      updatedAt: new Date(now - 3000),
    },
    // B: published + public + in_progress (newest) — must appear, proves status ignored
    {
      serverId: SERVER_ID,
      title: 'B-inprog-newest',
      status: 'in_progress',
      visibility: 'public',
      isPublished: true,
      updatedAt: new Date(now - 1000),
    },
    // C: published + public + deployed (mid) — must appear
    {
      serverId: SERVER_ID,
      title: 'C-deployed-mid',
      status: 'deployed',
      visibility: 'public',
      isPublished: true,
      updatedAt: new Date(now - 2000),
    },
    // D: NOT published — must be excluded
    {
      serverId: SERVER_ID,
      title: 'D-unpublished',
      status: 'done',
      visibility: 'public',
      isPublished: false,
      updatedAt: new Date(now - 500),
    },
    // E: private visibility — must be excluded
    {
      serverId: SERVER_ID,
      title: 'E-private',
      status: 'done',
      visibility: 'private',
      isPublished: true,
      updatedAt: new Date(now - 400),
    },
  ]);
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('listPublishedTickets', () => {
  it('returns only isPublished + public tickets regardless of status, ordered by updatedAt desc', async () => {
    const result = await listPublishedTickets(PROJECT_ID);
    const titles = result.tickets.map((t) => t.title);

    // Exactly three rows pass the gate
    expect(result.tickets.length).toBe(3);

    // Order: updatedAt DESC — B (newest) → C (mid) → A (oldest)
    expect(titles[0]).toBe('B-inprog-newest');
    expect(titles[1]).toBe('C-deployed-mid');
    expect(titles[2]).toBe('A-done-oldest');

    // D excluded: isPublished=false gate
    expect(titles.some((t) => t === 'D-unpublished')).toBe(false);

    // E excluded: visibility=private gate
    expect(titles.some((t) => t === 'E-private')).toBe(false);
  });

  it('returns the same envelope shape as listTickets', async () => {
    const result = await listPublishedTickets(PROJECT_ID);
    expect(result).toHaveProperty('projectName');
    expect(result).toHaveProperty('projectSlug');
    expect(result).toHaveProperty('homepageUrl');
    expect(result).toHaveProperty('isIdentified');
    expect(result).toHaveProperty('tickets');
    expect(result.isIdentified).toBe(false);
  });

  it('sets isIdentified=true when widgetUserId is provided', async () => {
    const result = await listPublishedTickets(PROJECT_ID, 'fake-widget-user-id');
    expect(result.isIdentified).toBe(true);
  });
});
