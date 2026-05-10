import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects, widgetUsers } from '../../db/schema';
import { listTickets, listDoneTickets } from './WidgetService';

// Verifies that the widget bootstrap response exposes `loginUrl` only to
// anonymous viewers of public projects — not to authenticated users, and
// not to viewers of non-public projects. This is the contract the widget
// JS depends on to decide whether to show the redirect-to-login flow.

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_lu_test_${RUN_HEX}`;
const USER_ID = `00000000-0003-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const LOGIN_URL = 'https://acme.test/login';

let PUBLIC_PROJECT_ID: string;
let PRIVATE_PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [pubProject] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Public ${RUN_HEX}`,
    slug: `public-${RUN_HEX}`,
    apiKey: `pub-key-${RUN_HEX}`,
    apiSecretHash: `pub-secret-${RUN_HEX}`,
    enabled: true,
    isPublic: true,
    widgetLoginUrl: LOGIN_URL,
  }).returning({ id: widgetProjects.id });
  if (!pubProject) throw new Error('seed failed');
  PUBLIC_PROJECT_ID = pubProject.id;

  const [privProject] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Private ${RUN_HEX}`,
    slug: `private-${RUN_HEX}`,
    apiKey: `priv-key-${RUN_HEX}`,
    apiSecretHash: `priv-secret-${RUN_HEX}`,
    enabled: true,
    isPublic: false,
    // login URL stored even for non-public — bootstrap should still hide it.
    widgetLoginUrl: LOGIN_URL,
  }).returning({ id: widgetProjects.id });
  if (!privProject) throw new Error('seed failed');
  PRIVATE_PROJECT_ID = privProject.id;

  // Insert a widget user so we can simulate "authenticated caller".
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PUBLIC_PROJECT_ID,
    externalUserId: `ext-${RUN_HEX}`,
    name: 'Authed User',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu.id;

  await db.insert(workspaceTasks).values([
    { serverId: SERVER_ID, title: 'Visible', status: 'pending', visibility: 'public' },
  ]);
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.id, WIDGET_USER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PUBLIC_PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PRIVATE_PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('listTickets — loginUrl exposure', () => {
  it('returns loginUrl to anonymous viewers of a public project', async () => {
    const result = await listTickets(PUBLIC_PROJECT_ID);
    expect(result.isPublic).toBe(true);
    expect(result.isIdentified).toBe(false);
    expect(result.loginUrl).toBe(LOGIN_URL);
  });

  it('omits loginUrl (null) for authenticated viewers of a public project', async () => {
    const result = await listTickets(PUBLIC_PROJECT_ID, WIDGET_USER_ID);
    expect(result.isPublic).toBe(true);
    expect(result.isIdentified).toBe(true);
    expect(result.loginUrl).toBeNull();
  });

  it('omits loginUrl (null) for non-public projects, even with stored URL', async () => {
    const result = await listTickets(PRIVATE_PROJECT_ID);
    expect(result.isPublic).toBe(false);
    expect(result.loginUrl).toBeNull();
  });
});

describe('listDoneTickets — loginUrl exposure', () => {
  it('returns loginUrl to anonymous viewers of a public project', async () => {
    const result = await listDoneTickets(PUBLIC_PROJECT_ID);
    expect(result.isPublic).toBe(true);
    expect(result.loginUrl).toBe(LOGIN_URL);
  });

  it('omits loginUrl for authenticated callers and non-public projects', async () => {
    const authedRes = await listDoneTickets(PUBLIC_PROJECT_ID, WIDGET_USER_ID);
    expect(authedRes.loginUrl).toBeNull();

    const privRes = await listDoneTickets(PRIVATE_PROJECT_ID);
    expect(privRes.loginUrl).toBeNull();
  });
});
