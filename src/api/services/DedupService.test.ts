/**
 * DedupService.test.ts — Integration tests against the scratch Postgres.
 *
 * Uses a stub callModel (no real API key required).
 * Mirrors the ClarifierService.test.ts setup/teardown pattern.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks } from '../../db/schema';
import { findLikelyDuplicate } from './DedupService';
import type { CallModel } from './ClarifierService';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_dedup_test_${RUN_HEX}`;
const USER_ID = `00000000-0004-4000-a000-${RUN_HEX.padStart(12, '0')}`;

// Seeded task ids (assigned after insert)
let TICKET_A_ID: string; // existing open ticket
let TICKET_B_ID: string; // existing open ticket
let CANDIDATE_ID: string; // the new ticket being checked

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  // Two existing open tickets
  const [a] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    title: 'Login broken with SSO',
    description: 'Users cannot sign in using SSO — getting a 500 error',
    status: 'pending',
    visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  TICKET_A_ID = a!.id;

  const [b] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    title: 'Add dark mode',
    description: 'We want a dark theme toggle in settings',
    status: 'in_progress',
    visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  TICKET_B_ID = b!.id;

  // The candidate (new ticket — excluded from its own dedup check)
  const [c] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    title: 'SSO sign-in fails',
    description: 'Cannot log in via SSO, 500 error shown',
    status: 'pending',
    visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  CANDIDATE_ID = c!.id;
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

// ---------------------------------------------------------------------------
// Stub model factories
// ---------------------------------------------------------------------------

/** Returns a stub model that always outputs the given duplicateOf id (or null). */
function stubModel(duplicateOf: string | null): CallModel {
  return async () => JSON.stringify({ duplicateOf });
}

/** Returns a stub model that always throws. */
function failingModel(): CallModel {
  return async () => { throw new Error('model exploded'); };
}

/** Returns a stub model that returns unparseable garbage. */
function garbledModel(): CallModel {
  return async () => 'Not valid JSON at all!';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DedupService.findLikelyDuplicate', () => {
  it('returns duplicateOf when stub model names an existing ticket id', async () => {
    const result = await findLikelyDuplicate(
      {
        serverId: SERVER_ID,
        ticketId: CANDIDATE_ID,
        candidate: { title: 'SSO sign-in fails', description: 'Cannot log in via SSO' },
      },
      { callModel: stubModel(TICKET_A_ID) },
    );
    expect(result).toEqual({ duplicateOf: TICKET_A_ID });
  });

  it('returns null when stub model returns null', async () => {
    const result = await findLikelyDuplicate(
      {
        serverId: SERVER_ID,
        ticketId: CANDIDATE_ID,
        candidate: { title: 'Add dark mode', description: 'Dark theme request' },
      },
      { callModel: stubModel(null) },
    );
    expect(result).toEqual({ duplicateOf: null });
  });

  it('returns null without calling the model when there are no candidate tickets (empty server)', async () => {
    const EMPTY_SERVER_ID = `ws_dedup_empty_${RUN_HEX}`;
    let called = false;

    // Insert a minimal server row (no tasks)
    await db.insert(servers).values({ id: EMPTY_SERVER_ID, name: `Empty ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

    // Insert a fake candidate task just so we have a ticketId to exclude
    const [fake] = await db.insert(workspaceTasks).values({
      serverId: EMPTY_SERVER_ID, title: 'Fake', visibility: 'public', status: 'pending',
    }).returning({ id: workspaceTasks.id });

    try {
      const mockModel: CallModel = async () => { called = true; return '{}'; };
      const result = await findLikelyDuplicate(
        { serverId: EMPTY_SERVER_ID, ticketId: fake!.id, candidate: { title: 'Fake ticket' } },
        { callModel: mockModel },
      );
      expect(result).toEqual({ duplicateOf: null });
      expect(called).toBe(false);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, EMPTY_SERVER_ID));
      await db.delete(servers).where(eq(servers.id, EMPTY_SERVER_ID));
    }
  });

  it('returns null (fail-open) when model throws', async () => {
    const result = await findLikelyDuplicate(
      {
        serverId: SERVER_ID,
        ticketId: CANDIDATE_ID,
        candidate: { title: 'SSO sign-in fails', description: 'Cannot log in' },
      },
      { callModel: failingModel() },
    );
    expect(result).toEqual({ duplicateOf: null });
  });

  it('returns null (fail-open) when model returns unparseable output', async () => {
    const result = await findLikelyDuplicate(
      {
        serverId: SERVER_ID,
        ticketId: CANDIDATE_ID,
        candidate: { title: 'SSO sign-in fails', description: 'Cannot log in' },
      },
      { callModel: garbledModel() },
    );
    expect(result).toEqual({ duplicateOf: null });
  });

  it('excludes done/deployed/cancelled tickets from the candidate set', async () => {
    // Insert a closed ticket; stub returns its id — the model should never be
    // called with it as a valid id, so parseDedupVerdict will throw → fail-open null.
    const [closed] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID,
      title: 'Closed SSO issue',
      description: 'Resolved last week',
      status: 'done',
      visibility: 'public',
    }).returning({ id: workspaceTasks.id });

    // Stub that tries to return the closed ticket id — should fail-open
    const result = await findLikelyDuplicate(
      { serverId: SERVER_ID, ticketId: CANDIDATE_ID, candidate: { title: 'SSO issue' } },
      { callModel: stubModel(closed!.id) },
    );
    // The closed ticket is not in the valid set, so parseDedupVerdict throws → null
    expect(result).toEqual({ duplicateOf: null });

    await db.delete(workspaceTasks).where(eq(workspaceTasks.id, closed!.id));
  });

  it('excludes the candidate ticket itself from comparison', async () => {
    // Stub that returns the candidate's own id — should fail-open because it's not in the valid set
    const result = await findLikelyDuplicate(
      { serverId: SERVER_ID, ticketId: CANDIDATE_ID, candidate: { title: 'SSO sign-in fails' } },
      { callModel: stubModel(CANDIDATE_ID) },
    );
    expect(result).toEqual({ duplicateOf: null });
  });
});
