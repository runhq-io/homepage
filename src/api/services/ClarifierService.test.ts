/**
 * ClarifierService.test.ts — Integration tests against the scratch Postgres.
 *
 * Uses a stub callModel (no real API key required).
 * Mirrors the setup/teardown pattern from WidgetService.comments.test.ts.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  workspaceTasks,
  widgetClarifications,
  widgetClarificationQuestions,
  widgetChatConversations,
  widgetChatMessages,
} from '../../db/schema';
import {
  startClarification,
  answerClarification,
  getOwnedClarification,
  markClarificationStarted,
  getTicketClarification,
  getAnsweredQa,
  defaultLoadIntakeQa,
  ClarifierAnswerError,
  type CallModel,
} from './ClarifierService';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_clarif_test_${RUN_HEX}`;
const USER_ID = `00000000-0003-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;
let TASK_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Clarif Test ${RUN_HEX}`,
    slug: `clarif-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`,
    apiSecretHash: `secret-${RUN_HEX}`,
    channelId: `ch_clarif_${RUN_HEX}`,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID,
    externalUserId: `ext-${RUN_HEX}`,
    name: 'Test User',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;

  const [t] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    title: 'Fix login bug',
    description: 'Users cannot log in with SSO',
    visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = t!.id;
});

afterAll(async () => {
  // Delete in FK-safe order.
  // widgetClarificationQuestions cascade-deletes when widgetClarifications are deleted (FK onDelete:'cascade').
  await db.delete(widgetClarifications).where(eq(widgetClarifications.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

// ---------------------------------------------------------------------------
// Helper: create a fresh task for each test to avoid ID collisions
// ---------------------------------------------------------------------------
async function makeTask(title: string, description: string | null = null): Promise<string> {
  const [t] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    title,
    description,
    visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  return t!.id;
}

// ---------------------------------------------------------------------------
// Test 1: startClarification → asking (returns questions, persists rows)
// ---------------------------------------------------------------------------
describe('startClarification', () => {
  it('returns status:asking and persists 1 clarification row + 1 question row (round 0)', async () => {
    const taskId = await makeTask('Dropdown broken', 'The dropdown does not open');

    const stub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'Which browser?' }] })
    );

    const result = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'agent-test-1', command: 'Fix the dropdown', ticket: { title: 'Dropdown broken', description: 'The dropdown does not open' } },
      { callModel: stub },
    );

    expect(result.status).toBe('asking');
    expect(result.clarificationId).toBeTruthy();
    if (result.status !== 'asking') throw new Error('type narrowing');
    expect(result.round).toBe(0);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.prompt).toBe('Which browser?');
    expect(result.questions[0]!.id).toBeTruthy();

    // Verify DB: clarification row
    const [clarRow] = await db
      .select()
      .from(widgetClarifications)
      .where(eq(widgetClarifications.id, result.clarificationId));
    expect(clarRow).toBeTruthy();
    expect(clarRow!.status).toBe('asking');
    expect(clarRow!.round).toBe(0);
    expect(clarRow!.taskId).toBe(taskId);
    expect(clarRow!.serverId).toBe(SERVER_ID);
    expect(clarRow!.widgetUserId).toBe(WIDGET_USER_ID);
    // Part A: verify agentId+command persisted on the row
    expect(clarRow!.agentId).toBe('agent-test-1');
    expect(clarRow!.command).toBe('Fix the dropdown');

    // Verify DB: question row
    const questions = await db
      .select()
      .from(widgetClarificationQuestions)
      .where(eq(widgetClarificationQuestions.clarificationId, result.clarificationId));
    expect(questions).toHaveLength(1);
    expect(questions[0]!.prompt).toBe('Which browser?');
    expect(questions[0]!.status).toBe('pending');
    expect(questions[0]!.round).toBe(0);
    expect(questions[0]!.answer).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 2: startClarification → ready immediately
  // -------------------------------------------------------------------------
  it('returns status:ready and sets clarification row to ready when model says ready:true', async () => {
    const taskId = await makeTask('Clear title with full spec', 'Comprehensive description');

    const stub: CallModel = vi.fn().mockResolvedValue(JSON.stringify({ ready: true }));

    const result = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'agent-test-1', command: 'Fix it', ticket: { title: 'Clear title', description: 'Full spec' } },
      { callModel: stub },
    );

    expect(result.status).toBe('ready');
    expect(result.clarificationId).toBeTruthy();

    // Verify DB: clarification status = ready
    const [clarRow] = await db
      .select()
      .from(widgetClarifications)
      .where(eq(widgetClarifications.id, result.clarificationId));
    expect(clarRow!.status).toBe('ready');

    // No question rows
    const questions = await db
      .select()
      .from(widgetClarificationQuestions)
      .where(eq(widgetClarificationQuestions.clarificationId, result.clarificationId));
    expect(questions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Full loop — start → answer → ready
// ---------------------------------------------------------------------------
describe('answerClarification', () => {
  it('full loop: ask 1 question → answer → model returns ready → status:ready, question answered', async () => {
    const taskId = await makeTask('Full loop test', 'Some description');

    // Start: stub returns 1 question
    const startStub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'What platform?' }] })
    );
    const startResult = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'agent-test-1', command: 'Fix it', ticket: { title: 'Full loop test', description: 'Some description' } },
      { callModel: startStub },
    );
    expect(startResult.status).toBe('asking');
    if (startResult.status !== 'asking') throw new Error('type narrowing');
    const questionId = startResult.questions[0]!.id;

    // Answer: stub now returns ready
    const answerStub: CallModel = vi.fn().mockResolvedValue(JSON.stringify({ ready: true }));
    const answerResult = await answerClarification(
      startResult.clarificationId,
      [{ questionId, answer: 'macOS' }],
      { callModel: answerStub },
    );

    expect(answerResult.status).toBe('ready');
    expect(answerResult.clarificationId).toBe(startResult.clarificationId);

    // Clarification row: status = ready, round = 1
    const [clarRow] = await db
      .select()
      .from(widgetClarifications)
      .where(eq(widgetClarifications.id, startResult.clarificationId));
    expect(clarRow!.status).toBe('ready');
    expect(clarRow!.round).toBe(1);

    // Question row: answered, with stored answer
    const [qRow] = await db
      .select()
      .from(widgetClarificationQuestions)
      .where(eq(widgetClarificationQuestions.id, questionId));
    expect(qRow!.status).toBe('answered');
    expect(qRow!.answer).toBe('macOS');
    expect(qRow!.answeredAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 4: partial answers — do NOT advance round
  // -------------------------------------------------------------------------
  it('partial answers: answering 1 of 2 questions returns still-pending asking state, does NOT advance round', async () => {
    const taskId = await makeTask('Partial answer test', null);

    // Start with 2 questions
    const startStub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        ready: false,
        questions: [
          { prompt: 'What device?' },
          { prompt: 'Which OS?' },
        ],
      })
    );
    const startResult = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'agent-test-1', command: 'Fix it', ticket: { title: 'Partial answer test', description: null } },
      { callModel: startStub },
    );
    expect(startResult.status).toBe('asking');
    if (startResult.status !== 'asking') throw new Error('type narrowing');
    expect(startResult.questions).toHaveLength(2);

    const firstQuestionId = startResult.questions[0]!.id;

    // Answer only the first question (valid pending id) — model stub should NOT be called.
    // This is NOT a mismatch (1 provided, 1 applied) — should return asking, not throw.
    const answerStub: CallModel = vi.fn().mockResolvedValue(JSON.stringify({ ready: true }));
    const answerResult = await answerClarification(
      startResult.clarificationId,
      [{ questionId: firstQuestionId, answer: 'iPhone' }],
      { callModel: answerStub },
    );

    // Still asking, with the remaining question
    expect(answerResult.status).toBe('asking');
    if (answerResult.status !== 'asking') throw new Error('type narrowing');
    expect(answerResult.questions).toHaveLength(1);
    expect(answerResult.questions[0]!.prompt).toBe('Which OS?');

    // Model was NOT called (no round advance)
    expect(answerStub).not.toHaveBeenCalled();

    // Clarification round is still 0
    const [clarRow] = await db
      .select()
      .from(widgetClarifications)
      .where(eq(widgetClarifications.id, startResult.clarificationId));
    expect(clarRow!.round).toBe(0);
    expect(clarRow!.status).toBe('asking');
  });

  // -------------------------------------------------------------------------
  // Test 5: parse-failure fallback — generic question, no throw
  // -------------------------------------------------------------------------
  it('parse-failure fallback: model returns garbage (both call + retry) → status:asking with generic fallback question', async () => {
    const taskId = await makeTask('Parse failure test', 'desc');

    const garbageStub: CallModel = vi.fn().mockResolvedValue('this is not JSON at all!!!');

    const result = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'agent-test-1', command: 'Fix it', ticket: { title: 'Parse failure test', description: 'desc' } },
      { callModel: garbageStub },
    );

    // Should NOT throw — must degrade gracefully
    expect(result.status).toBe('asking');
    if (result.status !== 'asking') throw new Error('type narrowing');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.prompt).toBe(
      'Could you describe the expected behavior and any specific details the developer should know?'
    );

    // Stub was called twice (initial + retry)
    expect(garbageStub).toHaveBeenCalledTimes(2);

    // Fallback question persisted in DB
    const questions = await db
      .select()
      .from(widgetClarificationQuestions)
      .where(eq(widgetClarificationQuestions.clarificationId, result.clarificationId));
    expect(questions).toHaveLength(1);
    expect(questions[0]!.prompt).toBe(
      'Could you describe the expected behavior and any specific details the developer should know?'
    );
  });

  // -------------------------------------------------------------------------
  // Test 6: unknown questionId → throws ClarifierAnswerError, round NOT advanced
  // -------------------------------------------------------------------------
  it('throws ClarifierAnswerError and does not advance round when a questionId does not match a pending question', async () => {
    const taskId = await makeTask('Unknown ID test', 'desc');

    // Start with 1 question
    const startStub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'What went wrong?' }] })
    );
    const startResult = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'agent-test-1', command: 'Fix it', ticket: { title: 'Unknown ID test', description: 'desc' } },
      { callModel: startStub },
    );
    expect(startResult.status).toBe('asking');
    if (startResult.status !== 'asking') throw new Error('type narrowing');

    // Provide a random UUID that does not belong to this clarification
    const bogusId = '00000000-0000-4000-a000-000000000000';
    const answerStub: CallModel = vi.fn().mockResolvedValue(JSON.stringify({ ready: true }));

    await expect(
      answerClarification(
        startResult.clarificationId,
        [{ questionId: bogusId, answer: 'some answer' }],
        { callModel: answerStub },
      )
    ).rejects.toThrow(ClarifierAnswerError);

    // Model must NOT have been called — clarification was not advanced
    expect(answerStub).not.toHaveBeenCalled();

    // Round must remain 0
    const [clarRow] = await db
      .select()
      .from(widgetClarifications)
      .where(eq(widgetClarifications.id, startResult.clarificationId));
    expect(clarRow!.round).toBe(0);
    expect(clarRow!.status).toBe('asking');
  });
});

// ---------------------------------------------------------------------------
// getOwnedClarification — ownership enforcement
// ---------------------------------------------------------------------------
describe('getOwnedClarification', () => {
  it('returns the row when taskId and widgetUserId both match', async () => {
    const taskId = await makeTask('Ownership test — correct', 'desc');
    const stub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'Which browser?' }] })
    );
    const started = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'ag-1', command: 'Fix it', ticket: { title: 'Ownership test', description: 'desc' } },
      { callModel: stub },
    );

    const clar = await getOwnedClarification(started.clarificationId, {
      taskId,
      widgetUserId: WIDGET_USER_ID,
    });

    expect(clar).not.toBeNull();
    expect(clar!.id).toBe(started.clarificationId);
    expect(clar!.taskId).toBe(taskId);
    expect(clar!.widgetUserId).toBe(WIDGET_USER_ID);
  });

  it('returns null when taskId does not match', async () => {
    const taskId = await makeTask('Ownership test — wrong taskId', 'desc');
    const stub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'Which browser?' }] })
    );
    const started = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'ag-1', command: 'Fix it', ticket: { title: 'Wrong task test', description: 'desc' } },
      { callModel: stub },
    );

    const wrongTaskId = await makeTask('Unrelated task', null);
    const clar = await getOwnedClarification(started.clarificationId, {
      taskId: wrongTaskId,
      widgetUserId: WIDGET_USER_ID,
    });

    expect(clar).toBeNull();
  });

  it('returns null when widgetUserId does not match', async () => {
    const taskId = await makeTask('Ownership test — wrong widgetUserId', 'desc');
    const stub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'Which browser?' }] })
    );
    const started = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'ag-1', command: 'Fix it', ticket: { title: 'Wrong user test', description: 'desc' } },
      { callModel: stub },
    );

    // Use a valid UUID format that belongs to no row in the DB
    const clar = await getOwnedClarification(started.clarificationId, {
      taskId,
      widgetUserId: '00000000-dead-4000-beef-000000000000',
    });

    expect(clar).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getTicketClarification — active-over-duplicate ordering (Fix 1)
// ---------------------------------------------------------------------------
describe('getTicketClarification', () => {
  it('returns the active (asking) clarification even when a duplicate row has a newer createdAt', async () => {
    // Scenario: two rows for the same taskId.
    //   Row A — status 'asking',   inserted first  (older createdAt)
    //   Row B — status 'duplicate', inserted second (newer createdAt)
    // Plain DESC ordering would surface Row B.
    // With the CASE-based deprioritisation, Row A (active) must win.
    const taskId = await makeTask('Dup-ordering test', 'desc');

    const past = new Date(Date.now() - 5_000); // 5 seconds ago
    const now  = new Date();

    // Insert the asking row with an explicitly earlier timestamp
    const [rowA] = await db.insert(widgetClarifications).values({
      taskId,
      serverId: SERVER_ID,
      widgetUserId: WIDGET_USER_ID,
      agentId: 'agent-dup-test',
      command: 'do the thing',
      status: 'asking',
      round: 0,
      createdAt: past,
    }).returning({ id: widgetClarifications.id, status: widgetClarifications.status });

    // Insert the duplicate row with a newer timestamp
    const [rowB] = await db.insert(widgetClarifications).values({
      taskId,
      serverId: SERVER_ID,
      widgetUserId: WIDGET_USER_ID,
      agentId: 'agent-dup-test',
      command: 'do the thing',
      status: 'duplicate',
      round: 0,
      createdAt: now,
    }).returning({ id: widgetClarifications.id, status: widgetClarifications.status });

    try {
      const result = await getTicketClarification(taskId);
      expect(result).not.toBeNull();
      // Must surface the asking row, not the newer duplicate
      expect(result!.id).toBe(rowA!.id);
      expect(result!.status).toBe('asking');
    } finally {
      await db.delete(widgetClarifications).where(eq(widgetClarifications.id, rowA!.id));
      await db.delete(widgetClarifications).where(eq(widgetClarifications.id, rowB!.id));
    }
  });
});

// ---------------------------------------------------------------------------
// getAnsweredQa — Q&A export for workspace seeding
// ---------------------------------------------------------------------------
describe('getAnsweredQa', () => {
  it('returns answered questions in creation order, joins array answers with ", ", excludes pending questions', async () => {
    const taskId = await makeTask('getAnsweredQa test', 'desc');

    // Start with 2 questions
    const startStub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        ready: false,
        questions: [
          { prompt: 'What browser?', options: ['Chrome', 'Firefox', 'Safari'], multiselect: false },
          { prompt: 'Which platforms?', options: ['macOS', 'Windows', 'Linux'], multiselect: true },
        ],
      }),
    );
    const startResult = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'ag-qa', command: 'Fix it', ticket: { title: 'getAnsweredQa test', description: 'desc' } },
      { callModel: startStub },
    );
    expect(startResult.status).toBe('asking');
    if (startResult.status !== 'asking') throw new Error('type narrowing');
    const [q1, q2] = startResult.questions;

    // Empty before any answers
    const emptyResult = await getAnsweredQa(startResult.clarificationId);
    expect(emptyResult).toHaveLength(0);

    // Answer first question with a string value
    await db
      .update(widgetClarificationQuestions)
      .set({ status: 'answered', answer: 'Chrome', answeredAt: new Date() })
      .where(eq(widgetClarificationQuestions.id, q1!.id));

    // Answer second question with a string[] value (simulates multiselect)
    await db
      .update(widgetClarificationQuestions)
      .set({ status: 'answered', answer: ['macOS', 'Windows'], answeredAt: new Date() })
      .where(eq(widgetClarificationQuestions.id, q2!.id));

    const qa = await getAnsweredQa(startResult.clarificationId);

    // Both answered questions returned
    expect(qa).toHaveLength(2);

    // Ordered by createdAt → q1 first, q2 second
    expect(qa[0]).toEqual({ question: 'What browser?', answer: 'Chrome' });
    expect(qa[1]).toEqual({ question: 'Which platforms?', answer: 'macOS, Windows' });
  });

  it('excludes pending questions and returns only answered ones', async () => {
    const taskId = await makeTask('getAnsweredQa partial test', 'desc');

    const startStub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        ready: false,
        questions: [{ prompt: 'Q answered' }, { prompt: 'Q still pending' }],
      }),
    );
    const startResult = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'ag-qa2', command: 'Do it', ticket: { title: 'partial test', description: null } },
      { callModel: startStub },
    );
    expect(startResult.status).toBe('asking');
    if (startResult.status !== 'asking') throw new Error('type narrowing');
    const [q1] = startResult.questions;

    // Answer only the first question
    await db
      .update(widgetClarificationQuestions)
      .set({ status: 'answered', answer: 'yes', answeredAt: new Date() })
      .where(eq(widgetClarificationQuestions.id, q1!.id));

    const qa = await getAnsweredQa(startResult.clarificationId);

    // Only the answered row is returned
    expect(qa).toHaveLength(1);
    expect(qa[0]).toEqual({ question: 'Q answered', answer: 'yes' });
  });

  it('returns empty array for a clarification with no questions (ready-immediately path)', async () => {
    const taskId = await makeTask('getAnsweredQa empty test', 'desc');
    const stub: CallModel = vi.fn().mockResolvedValue(JSON.stringify({ ready: true }));
    const startResult = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'ag-qa3', command: 'Fix', ticket: { title: 'empty test', description: null } },
      { callModel: stub },
    );
    expect(startResult.status).toBe('ready');

    const qa = await getAnsweredQa(startResult.clarificationId);
    expect(qa).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// markClarificationStarted — status transition
// ---------------------------------------------------------------------------
describe('markClarificationStarted', () => {
  it('sets status to started on the clarification row', async () => {
    const taskId = await makeTask('Mark started test', 'desc');
    const stub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'Which OS?' }] })
    );
    const started = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'ag-2', command: 'Do it', ticket: { title: 'Mark started test', description: 'desc' } },
      { callModel: stub },
    );

    // Verify it starts as 'asking'
    const [beforeRow] = await db
      .select({ status: widgetClarifications.status })
      .from(widgetClarifications)
      .where(eq(widgetClarifications.id, started.clarificationId));
    expect(beforeRow!.status).toBe('asking');

    // Transition
    await markClarificationStarted(started.clarificationId);

    // Verify status is now 'started'
    const [afterRow] = await db
      .select({ status: widgetClarifications.status, updatedAt: widgetClarifications.updatedAt })
      .from(widgetClarifications)
      .where(eq(widgetClarifications.id, started.clarificationId));
    expect(afterRow!.status).toBe('started');
  });
});

// ---------------------------------------------------------------------------
// Intake Q&A threading — the chat-intake conversation must reach the clarifier
// so an already-clarified ticket short-circuits to 'ready' instead of being
// re-interrogated from scratch (the redundant-clarification fix).
// ---------------------------------------------------------------------------
describe('intake Q&A threading', () => {
  it('startClarification feeds injected intake Q&A into the model prompt', async () => {
    const taskId = await makeTask('Dark mode', 'Add a dark theme');

    let seenContent = '';
    const stub: CallModel = vi.fn().mockImplementation(async (args) => {
      seenContent = args.messages.map((m) => m.content).join('\n');
      return JSON.stringify({ ready: true });
    });

    const result = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'a1', command: 'do it', ticket: { title: 'Dark mode', description: 'Add a dark theme' } },
      {
        callModel: stub,
        loadIntakeQa: async () => [
          { question: 'Which screens need it?', answer: 'All of them' },
          { question: 'Follow system setting?', answer: 'Yes' },
        ],
      },
    );

    expect(result.status).toBe('ready');
    expect(seenContent).toContain('Which screens need it?');
    expect(seenContent).toContain('All of them');
    expect(seenContent).toContain('Follow system setting?');
  });

  it('answerClarification prepends intake Q&A to the answered-round Q&A', async () => {
    const taskId = await makeTask('Thin ticket', 'vague');

    // Round 0: ask one question (no intake yet for this leg)
    const askStub: CallModel = vi.fn().mockResolvedValue(
      JSON.stringify({ ready: false, questions: [{ prompt: 'What exactly is broken?' }] }),
    );
    const start = await startClarification(
      { serverId: SERVER_ID, taskId, widgetUserId: WIDGET_USER_ID, agentId: 'a1', command: 'do it', ticket: { title: 'Thin ticket', description: 'vague' } },
      { callModel: askStub, loadIntakeQa: async () => [] },
    );
    if (start.status !== 'asking') throw new Error('expected asking');

    // Round 1: answer it; assert the model sees BOTH the intake Q&A and the answer.
    let seenContent = '';
    const proceedStub: CallModel = vi.fn().mockImplementation(async (args) => {
      seenContent = args.messages.map((m) => m.content).join('\n');
      return JSON.stringify({ ready: true });
    });
    const step = await answerClarification(
      start.clarificationId,
      [{ questionId: start.questions[0]!.id, answer: 'the export button' }],
      {
        callModel: proceedStub,
        loadIntakeQa: async () => [{ question: 'From the chat: which page?', answer: 'Reports page' }],
      },
    );

    expect(step.status).toBe('ready');
    expect(seenContent).toContain('From the chat: which page?'); // intake Q&A
    expect(seenContent).toContain('Reports page');
    expect(seenContent).toContain('What exactly is broken?'); // answered round
    expect(seenContent).toContain('the export button');
  });

  it('defaultLoadIntakeQa reconstructs Q&A from the ticket\'s originating chat conversation', async () => {
    const taskId = await makeTask('From chat', 'created via chat');

    const [conv] = await db.insert(widgetChatConversations).values({
      widgetProjectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      status: 'closed',
      createdTaskId: taskId,
    }).returning({ id: widgetChatConversations.id });

    // Ordered transcript: leading user statement, agent question, user answer,
    // an interleaved event row (must be ignored), agent question, user answer.
    await db.insert(widgetChatMessages).values([
      { conversationId: conv!.id, role: 'user', content: 'The report export fails' },
      { conversationId: conv!.id, role: 'agent', content: 'Which format?' },
      { conversationId: conv!.id, role: 'user', content: 'PDF' },
      { conversationId: conv!.id, role: 'event', content: '', payload: { kind: 'collect_prompt' } as any },
      { conversationId: conv!.id, role: 'agent', content: 'How many rows?' },
      { conversationId: conv!.id, role: 'user', content: 'About 5000' },
    ]);

    const qa = await defaultLoadIntakeQa(taskId);
    expect(qa).toEqual([
      { question: 'Which format?', answer: 'PDF' },
      { question: 'How many rows?', answer: 'About 5000' },
    ]);
  });

  it('defaultLoadIntakeQa returns [] for a ticket with no originating conversation', async () => {
    const taskId = await makeTask('Native ticket', 'no chat');
    expect(await defaultLoadIntakeQa(taskId)).toEqual([]);
  });
});
