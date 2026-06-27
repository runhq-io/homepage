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
const CHANNEL_ID = `ch-ut-${RUN_HEX}`;
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
    channelId: CHANNEL_ID,
  }).returning({ id: widgetProjects.id });
  if (!project) throw new Error('seed failed');
  PROJECT_ID = project.id;

  const now = Date.now();
  await db.insert(workspaceTasks).values([
    // A: done, completed oldest, but most recently updated (e.g. just re-published).
    // Under the OLD updatedAt sort this would be first; under the new completedAt
    // sort it is LAST among the done items.
    {
      serverId: SERVER_ID,
      workspaceChannelId: CHANNEL_ID,
      title: 'A-done-oldest-completed',
      status: 'done',
      visibility: 'public',
      isPublished: true,
      completedAt: new Date(now - 30000),
      updatedAt: new Date(now - 100), // most recent updatedAt — proves we don't sort on it
    },
    // B: in_progress, no completedAt — published-but-not-done items must still
    // appear (status doesn't gate the feed) but sort to the bottom via NULLS LAST.
    {
      serverId: SERVER_ID,
      workspaceChannelId: CHANNEL_ID,
      title: 'B-inprog-no-completedAt',
      status: 'in_progress',
      visibility: 'public',
      isPublished: true,
      updatedAt: new Date(now - 1000),
    },
    // C: deployed, completed most recently — should be first.
    {
      serverId: SERVER_ID,
      workspaceChannelId: CHANNEL_ID,
      title: 'C-deployed-newest-completed',
      status: 'deployed',
      visibility: 'public',
      isPublished: true,
      completedAt: new Date(now - 10000),
      updatedAt: new Date(now - 5000),
    },
    // D: NOT published — must be excluded
    {
      serverId: SERVER_ID,
      workspaceChannelId: CHANNEL_ID,
      title: 'D-unpublished',
      status: 'done',
      visibility: 'public',
      isPublished: false,
      completedAt: new Date(now - 1),
      updatedAt: new Date(now - 1),
    },
    // E: private visibility — must be excluded
    {
      serverId: SERVER_ID,
      workspaceChannelId: CHANNEL_ID,
      title: 'E-private',
      status: 'done',
      visibility: 'private',
      isPublished: true,
      completedAt: new Date(now - 1),
      updatedAt: new Date(now - 1),
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
  it('returns only isPublished + public tickets regardless of status, ordered by completedAt desc (nulls last)', async () => {
    const result = await listPublishedTickets(PROJECT_ID);
    const titles = result.tickets.map((t) => t.title);

    // Exactly three rows pass the gate
    expect(result.tickets.length).toBe(3);

    // Order: completedAt DESC, NULLS LAST
    //   C completed most recently → first
    //   A completed earliest → second (even though A has the freshest updatedAt)
    //   B has no completedAt → last
    expect(titles[0]).toBe('C-deployed-newest-completed');
    expect(titles[1]).toBe('A-done-oldest-completed');
    expect(titles[2]).toBe('B-inprog-no-completedAt');

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
