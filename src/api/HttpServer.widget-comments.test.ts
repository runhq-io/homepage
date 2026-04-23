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
  };
});

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';

const makeApp = () => createHttpApp();

describe('GET /api/widget/tickets/updates', () => {
  beforeEach(() => vi.resetAllMocks());

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
  beforeEach(() => vi.resetAllMocks());

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
    (WidgetService.addWidgetComment as any).mockRejectedValue(new Error('Ticket not found'));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/widget/tickets/:id/comments/:commentId', () => {
  beforeEach(() => vi.resetAllMocks());

  it('403 when Not the comment author', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.updateWidgetComment as any).mockRejectedValue(new Error('Not the comment author'));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(403);
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
  beforeEach(() => vi.resetAllMocks());

  it('403 when Not the comment author', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.deleteWidgetComment as any).mockRejectedValue(new Error('Not the comment author'));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(403);
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
    (WidgetService.deleteWidgetComment as any).mockRejectedValue(new Error('Ticket not found'));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
