import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  serverTokenFetch: vi.fn(),
}));

vi.mock('./services/WidgetService', () => ({
  authenticateWidget: vi.fn(),
  listExposedAgents: vi.fn(),
  getWidgetProjectRateLimit: vi.fn(),
  getWidgetUserAuditInfo: vi.fn(),
  getTicketForAssign: vi.fn(),
  assignAgent: vi.fn(),
  WidgetAssignError: class WidgetAssignError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, cause?: unknown) {
      super(code);
      this.name = 'WidgetAssignError';
      this.code = code;
      this.status = status;
    }
  },
  WidgetError: class WidgetError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, cause?: unknown) {
      super(code);
      this.name = 'WidgetError';
      this.code = code;
      this.status = status;
    }
  },
  suggestAssignment: vi.fn(),
  listPublicProjects: vi.fn(),
}));

vi.mock('./services/ClarifierService', () => ({
  startClarification: vi.fn(),
  answerClarification: vi.fn(),
  getOwnedClarification: vi.fn(),
  markClarificationStarted: vi.fn(),
  ClarifierAnswerError: class ClarifierAnswerError extends Error {
    constructor(message = 'one or more answers did not match a pending question') {
      super(message);
      this.name = 'ClarifierAnswerError';
    }
  },
}));

vi.mock('./services/WidgetRateLimiter', () => ({
  widgetRateLimiter: {
    check: vi.fn(),
    checkDefault: vi.fn(),
  },
}));

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import * as ClarifierService from './services/ClarifierService';
import { widgetRateLimiter } from './services/WidgetRateLimiter';

const makeApp = () => createHttpApp();

const AUTHED_WITH_ASSIGN = {
  projectId: 'proj-1',
  projectSlug: 'proj-1-slug',
  widgetUserId: 'wu-123',
  authenticated: true,
  permissions: new Set<string>(['assign_agent']),
  matchedRoles: ['triager'],
};

const CLARIFICATION_ID = 'c1';
const TICKET_ID = 'ticket-abc';

const VALID_ANSWERS = [{ questionId: 'q1', answer: 'macOS' }];
const VALID_BODY = JSON.stringify({ clarificationId: CLARIFICATION_ID, answers: VALID_ANSWERS });

/** A clarification owned by the authed widget user for TICKET_ID. */
const OWNED_CLARIFICATION = {
  id: CLARIFICATION_ID,
  taskId: TICKET_ID,
  serverId: 'srv-1',
  widgetUserId: 'wu-123',
  agentId: 'a1',
  command: 'do it',
  status: 'asking',
  round: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const postClarifyAnswer = (
  app: ReturnType<typeof makeApp>,
  ticketId = TICKET_ID,
  body: string | null = VALID_BODY,
) =>
  app.request(`/api/widget/tickets/${ticketId}/clarify-answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== null ? { body } : {}),
  });

describe('POST /api/widget/tickets/:id/clarify-answer', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default happy-path stubs.
    (WidgetService.authenticateWidget as any).mockResolvedValue(AUTHED_WITH_ASSIGN);
    (WidgetService.getWidgetProjectRateLimit as any).mockResolvedValue(60);
    (widgetRateLimiter.check as any).mockReturnValue({ allowed: true, retryAfterSec: 0 });
    (ClarifierService.getOwnedClarification as any).mockResolvedValue(OWNED_CLARIFICATION);
    (ClarifierService.answerClarification as any).mockResolvedValue({ status: 'ready', clarificationId: CLARIFICATION_ID });
    (ClarifierService.markClarificationStarted as any).mockResolvedValue(undefined);
    (WidgetService.getWidgetUserAuditInfo as any).mockResolvedValue({ externalUserId: 'ext-user-1', name: 'Alice' });
    (WidgetService.assignAgent as any).mockResolvedValue({ jobId: 'job-001' });
  });

  // ---------------------------------------------------------------------------
  // Gate tests
  // ---------------------------------------------------------------------------

  it('401 when authenticateWidget returns null', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('403 when permissions does not include assign_agent', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      ...AUTHED_WITH_ASSIGN,
      permissions: new Set<string>(),
      matchedRoles: [],
    });
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('401 when widgetUserId is absent (anonymous / raw-key auth)', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      ...AUTHED_WITH_ASSIGN,
      widgetUserId: undefined,
    });
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Identified user required');
  });

  it('400 when body is not valid JSON', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(app, TICKET_ID, 'not-json');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 when clarificationId is missing', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(
      app,
      TICKET_ID,
      JSON.stringify({ answers: VALID_ANSWERS }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 when clarificationId is empty string', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(
      app,
      TICKET_ID,
      JSON.stringify({ clarificationId: '', answers: VALID_ANSWERS }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 when answers array is missing', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(
      app,
      TICKET_ID,
      JSON.stringify({ clarificationId: CLARIFICATION_ID }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 when answers array is empty', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(
      app,
      TICKET_ID,
      JSON.stringify({ clarificationId: CLARIFICATION_ID, answers: [] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 when an answer item is missing questionId', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(
      app,
      TICKET_ID,
      JSON.stringify({ clarificationId: CLARIFICATION_ID, answers: [{ answer: 'yes' }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 when an answer item has numeric answer (invalid type)', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(
      app,
      TICKET_ID,
      JSON.stringify({ clarificationId: CLARIFICATION_ID, answers: [{ questionId: 'q1', answer: 42 }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  // ---------------------------------------------------------------------------
  // Ownership gate
  // ---------------------------------------------------------------------------

  it('404 when getOwnedClarification returns null; answerClarification NOT called', async () => {
    (ClarifierService.getOwnedClarification as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('clarification_not_found');
    expect(ClarifierService.answerClarification).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Status guard (409)
  // ---------------------------------------------------------------------------

  it('409 clarification_not_open when clarification status is ready; answerClarification NOT called', async () => {
    (ClarifierService.getOwnedClarification as any).mockResolvedValue({
      ...OWNED_CLARIFICATION,
      status: 'ready',
    });
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('clarification_not_open');
    expect(ClarifierService.answerClarification).not.toHaveBeenCalled();
  });

  it('409 clarification_not_open when clarification status is started; answerClarification NOT called', async () => {
    (ClarifierService.getOwnedClarification as any).mockResolvedValue({
      ...OWNED_CLARIFICATION,
      status: 'started',
    });
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('clarification_not_open');
    expect(ClarifierService.answerClarification).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Rate limit
  // ---------------------------------------------------------------------------

  it('429 when rate limiter denies; Retry-After header set', async () => {
    (widgetRateLimiter.check as any).mockReturnValue({ allowed: false, retryAfterSec: 120 });
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('120');
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
  });

  // ---------------------------------------------------------------------------
  // answerClarification → asking (more questions needed)
  // ---------------------------------------------------------------------------

  it('200 with next questions when answerClarification returns asking; assignAgent NOT called', async () => {
    const nextQuestions = [{ id: 'q2', prompt: 'Which OS?', options: null, multiselect: false }];
    (ClarifierService.answerClarification as any).mockResolvedValue({
      status: 'asking',
      clarificationId: CLARIFICATION_ID,
      round: 1,
      questions: nextQuestions,
    });

    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      clarification: {
        clarificationId: CLARIFICATION_ID,
        status: 'asking',
        round: 1,
        questions: nextQuestions,
      },
    });
    expect(WidgetService.assignAgent).not.toHaveBeenCalled();
    expect(ClarifierService.markClarificationStarted).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // answerClarification → ready (job is started)
  // ---------------------------------------------------------------------------

  it('200 happy path: answerClarification returns ready → assignAgent called with stored agent+command; markClarificationStarted called', async () => {
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      jobId: 'job-001',
      agentId: 'a1',
      clarification: { clarificationId: CLARIFICATION_ID, status: 'started' },
    });

    // answerClarification called with the ids from the request body
    expect(ClarifierService.answerClarification).toHaveBeenCalledWith(
      CLARIFICATION_ID,
      VALID_ANSWERS,
    );

    // assignAgent called with STORED agent+command (from OWNED_CLARIFICATION), not from body
    expect(WidgetService.assignAgent).toHaveBeenCalledWith(
      'proj-1',
      TICKET_ID,
      {
        agentId: 'a1',
        command: 'do it',
        actor: {
          widgetUserId: 'wu-123',
          externalUserId: 'ext-user-1',
          name: 'Alice',
          matchedRoles: ['triager'],
        },
      },
    );

    expect(ClarifierService.markClarificationStarted).toHaveBeenCalledWith(CLARIFICATION_ID);
  });

  // ---------------------------------------------------------------------------
  // ClarifierAnswerError → 400 (bad answer ids)
  // ---------------------------------------------------------------------------

  it('400 invalid_answers when answerClarification throws ClarifierAnswerError; assignAgent NOT called', async () => {
    (ClarifierService.answerClarification as any).mockRejectedValue(
      new (ClarifierService.ClarifierAnswerError as any)('unknown question id'),
    );

    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_answers');
    expect(WidgetService.assignAgent).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Clarifier infra failure → 503 (fail-closed)
  // ---------------------------------------------------------------------------

  it('503 clarifier_unavailable when answerClarification throws a non-ClarifierAnswerError; assignAgent NOT called', async () => {
    (ClarifierService.answerClarification as any).mockRejectedValue(new Error('LLM timeout'));

    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('clarifier_unavailable');
    expect(WidgetService.assignAgent).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // assignAgent propagates errors via widgetErrorResponse
  // ---------------------------------------------------------------------------

  it('503 workspace_unreachable when assignAgent throws WidgetAssignError', async () => {
    const { WidgetAssignError } = await import('./services/WidgetService');
    (WidgetService.assignAgent as any).mockRejectedValue(
      new (WidgetAssignError as any)('workspace_unreachable', 503),
    );

    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('workspace_unreachable');
  });

  // ---------------------------------------------------------------------------
  // Widget user lookup miss
  // ---------------------------------------------------------------------------

  it('404 widget_user_not_found when getWidgetUserAuditInfo returns null (ready path)', async () => {
    (WidgetService.getWidgetUserAuditInfo as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await postClarifyAnswer(app);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('widget_user_not_found');
    expect(WidgetService.assignAgent).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Array answer values (multiselect support)
  // ---------------------------------------------------------------------------

  it('accepts string[] as answer value (multiselect)', async () => {
    const multiBody = JSON.stringify({
      clarificationId: CLARIFICATION_ID,
      answers: [{ questionId: 'q1', answer: ['option-a', 'option-b'] }],
    });

    const app = makeApp();
    const res = await postClarifyAnswer(app, TICKET_ID, multiBody);
    expect(res.status).toBe(200);
    expect(ClarifierService.answerClarification).toHaveBeenCalledWith(
      CLARIFICATION_ID,
      [{ questionId: 'q1', answer: ['option-a', 'option-b'] }],
    );
  });

  // ---------------------------------------------------------------------------
  // getOwnedClarification is called with correct ownership scope
  // ---------------------------------------------------------------------------

  it('getOwnedClarification is called with correct taskId and widgetUserId', async () => {
    const app = makeApp();
    await postClarifyAnswer(app, 'my-ticket-id');
    expect(ClarifierService.getOwnedClarification).toHaveBeenCalledWith(
      CLARIFICATION_ID,
      { taskId: 'my-ticket-id', widgetUserId: 'wu-123' },
    );
  });
});
