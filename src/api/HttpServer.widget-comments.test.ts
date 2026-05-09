import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({ checkCloudOpPermission: vi.fn(), getServer: vi.fn(), fetchFromServer: vi.fn() }));

vi.mock('./services/WidgetService', () => {
  class WidgetSettingsValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WidgetSettingsValidationError';
    }
  }
  class WidgetError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = 'WidgetError';
      this.code = code;
      this.status = status;
    }
  }
  class WidgetAssignError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = 'WidgetAssignError';
      this.code = code;
      this.status = status;
    }
  }
  return {
    authenticateWidget: vi.fn(),
    listDoneTickets: vi.fn(),
    addWidgetComment: vi.fn(),
    updateWidgetComment: vi.fn(),
    deleteWidgetComment: vi.fn(),
    addWidgetCommentAttachment: vi.fn(),
    enableWidget: vi.fn(),
    disableWidget: vi.fn(),
    updateWidgetSettings: vi.fn(),
    WidgetSettingsValidationError,
    WidgetError,
    WidgetAssignError,
  };
});

vi.mock('./services/WidgetRateLimiter', () => ({
  widgetRateLimiter: {
    check: vi.fn().mockReturnValue({ allowed: true, retryAfterSec: 0 }),
    checkDefault: vi.fn().mockReturnValue({ allowed: true, retryAfterSec: 0 }),
  },
}));

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import { widgetRateLimiter } from './services/WidgetRateLimiter';

// Re-apply rate-limiter default after each `vi.resetAllMocks()` since reset
// clears the implementation.
function resetMocks() {
  vi.resetAllMocks();
  (widgetRateLimiter.checkDefault as any).mockReturnValue({ allowed: true, retryAfterSec: 0 });
  (widgetRateLimiter.check as any).mockReturnValue({ allowed: true, retryAfterSec: 0 });
}

const makeApp = () => createHttpApp();

describe('GET /api/widget/tickets/updates', () => {
  beforeEach(() => resetMocks());

  it('401 when not authenticated', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/updates');
    expect(res.status).toBe(401);
  });

  it('200 with result from listDoneTickets', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: false });
    (WidgetService.listDoneTickets as any).mockResolvedValue({ tickets: [{ id: 't1' }] });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/updates');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickets[0].id).toBe('t1');
  });
});

describe('POST /api/widget/tickets/:id/comments', () => {
  beforeEach(() => resetMocks());

  it('401 without signed token', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: false });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('201 on success', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.addWidgetComment as any).mockResolvedValue({ id: 'c1', body: 'hi' });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.comment.id).toBe('c1');
  });

  it('404 when Ticket not found', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.addWidgetComment as any).mockRejectedValue(new (WidgetService.WidgetError as any)('ticket_not_found', 404));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'ticket_not_found' });
  });

  it('403 when Comments are disabled for this task', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.addWidgetComment as any).mockRejectedValue(new (WidgetService.WidgetError as any)('comments_disabled', 403));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'comments_disabled' });
  });
});

describe('PATCH /api/widget/tickets/:id/comments/:commentId', () => {
  beforeEach(() => resetMocks());

  it('403 when Not the comment author', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.updateWidgetComment as any).mockRejectedValue(new (WidgetService.WidgetError as any)('comment_author_only', 403));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'comment_author_only' });
  });

  it('200 on success with updated comment', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.updateWidgetComment as any).mockResolvedValue({ id: 'c1', body: 'edited' });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'edited' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/widget/tickets/:id/comments/:commentId', () => {
  beforeEach(() => resetMocks());

  it('403 when Not the comment author', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.deleteWidgetComment as any).mockRejectedValue(new (WidgetService.WidgetError as any)('comment_author_only', 403));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'comment_author_only' });
  });

  it('200 on success', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.deleteWidgetComment as any).mockResolvedValue(undefined);
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('404 when Ticket not found on DELETE', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.deleteWidgetComment as any).mockRejectedValue(new (WidgetService.WidgetError as any)('ticket_not_found', 404));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'ticket_not_found' });
  });
});
