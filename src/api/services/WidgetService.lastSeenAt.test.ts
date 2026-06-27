/**
 * resolveWidgetUserOnAuth — the shared widget-user upsert used by both the HTTP
 * (authenticateWidget) and WS (verifyWidgetUserJwt) auth paths.
 *
 * Contract under test:
 *  - existing user → returns their id, refreshes last_seen_at, preserves a real
 *    stored name when the JWT carries none, overwrites when it carries one.
 *  - new user → inserts with the provided name (or a fallback) and a fresh
 *    last_seen_at.
 *
 * This is the canonical place last_seen_at is kept current (the leaderboard
 * "recent" sort depends on it).
 */

import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index';
import { servers, users, widgetProjects, widgetUsers } from '../../db/schema';
import { resolveWidgetUserOnAuth } from './WidgetService';

const RUN_HEX = randomBytes(4).toString('hex');
const SERVER_ID = `ws_lastseen_${RUN_HEX}`;
const USER_ID = `00000000-6666-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;

beforeAll(async () => {
  await db
    .insert(users)
    .values({ id: USER_ID, email: `lastseen+${RUN_HEX}@test.invalid`, name: 'LastSeen Test' })
    .onConflictDoNothing();
  await db
    .insert(servers)
    .values({ id: SERVER_ID, name: `LastSeen Srv ${RUN_HEX}`, ownerId: USER_ID })
    .onConflictDoNothing();

  const [project] = await db
    .insert(widgetProjects)
    .values({
      serverId: SERVER_ID,
      name: `LastSeen Project ${RUN_HEX}`,
      slug: `lastseen-${RUN_HEX}`,
      apiKey: `apikey-lastseen-${RUN_HEX}`,
      apiSecretHash: `secret-lastseen-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    })
    .returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
});

afterAll(async () => {
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function getUser(sub: string) {
  const [u] = await db
    .select()
    .from(widgetUsers)
    .where(and(eq(widgetUsers.projectId, PROJECT_ID), eq(widgetUsers.externalUserId, sub)));
  return u;
}

describe('resolveWidgetUserOnAuth', () => {
  it('inserts a new user with the provided name and a fresh last_seen_at', async () => {
    const sub = `ext-new-${RUN_HEX}`;
    const id = await resolveWidgetUserOnAuth(PROJECT_ID, sub, 'Alice');

    const u = await getUser(sub);
    expect(u).toBeDefined();
    expect(u!.id).toBe(id);
    expect(u!.name).toBe('Alice');
    expect(u!.lastSeenAt).toBeInstanceOf(Date);
  });

  it('refreshes last_seen_at on a subsequent auth for an existing user', async () => {
    const sub = `ext-refresh-${RUN_HEX}`;
    await resolveWidgetUserOnAuth(PROJECT_ID, sub, 'Bob');

    // Backdate last_seen_at so we can prove it moves forward.
    const past = new Date('2020-01-01T00:00:00.000Z');
    await db.update(widgetUsers).set({ lastSeenAt: past })
      .where(and(eq(widgetUsers.projectId, PROJECT_ID), eq(widgetUsers.externalUserId, sub)));

    await resolveWidgetUserOnAuth(PROJECT_ID, sub, undefined);

    const u = await getUser(sub);
    expect(u!.lastSeenAt.getTime()).toBeGreaterThan(past.getTime());
  });

  it('preserves a real stored name when the JWT carries none', async () => {
    const sub = `ext-preserve-${RUN_HEX}`;
    await resolveWidgetUserOnAuth(PROJECT_ID, sub, 'Carol');

    await resolveWidgetUserOnAuth(PROJECT_ID, sub, undefined);

    const u = await getUser(sub);
    expect(u!.name).toBe('Carol');
  });

  it('overwrites the stored name when the JWT carries a new one', async () => {
    const sub = `ext-overwrite-${RUN_HEX}`;
    await resolveWidgetUserOnAuth(PROJECT_ID, sub, 'OldName');

    await resolveWidgetUserOnAuth(PROJECT_ID, sub, 'NewName');

    const u = await getUser(sub);
    expect(u!.name).toBe('NewName');
  });

  it('falls back to a pseudonymous label when no name is ever provided', async () => {
    const sub = `ext-fallback-${RUN_HEX}`;
    await resolveWidgetUserOnAuth(PROJECT_ID, sub, undefined);

    const u = await getUser(sub);
    expect(u!.name).toMatch(/^Anonymous \(/);
  });
});
