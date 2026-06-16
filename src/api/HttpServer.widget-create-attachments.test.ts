import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({ checkCloudOpPermission: vi.fn(), getServer: vi.fn(), fetchFromServer: vi.fn() }));
vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return true; } },
}));
vi.mock('./services/WidgetAutoAssign', () => ({
  autoAssignTicket: vi.fn(),
}));
vi.mock('./services/WidgetRateLimiter', () => ({
  widgetRateLimiter: {
    check: vi.fn().mockReturnValue({ allowed: true, retryAfterSec: 0 }),
    checkDefault: vi.fn().mockReturnValue({ allowed: true, retryAfterSec: 0 }),
  },
}));
vi.mock('./services/WidgetService', () => {
  class WidgetError extends Error {
    constructor(public readonly code: string, public readonly status: number) {
      super(code);
      this.name = 'WidgetError';
    }
  }
  class WidgetAssignError extends Error {
    constructor(public readonly code: string, public readonly status: number) {
      super(code);
      this.name = 'WidgetAssignError';
    }
  }
  return {
    authenticateWidget: vi.fn(),
    attachmentsEnabled: vi.fn(),
    createTicket: vi.fn(),
    createTicketWithAttachments: vi.fn(),
    WidgetError,
    WidgetAssignError,
  };
});

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import * as WidgetAutoAssign from './services/WidgetAutoAssign';
import { widgetRateLimiter } from './services/WidgetRateLimiter';

const AUTH = {
  projectId: 'proj-1',
  projectSlug: 'proj-slug',
  widgetUserId: 'wu-1',
  authenticated: true,
  permissions: new Set<string>(),
  matchedRoles: [],
  authSource: 'app' as const,
};

describe('POST /api/widget/tickets multipart create', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(widgetRateLimiter.check).mockReturnValue({ allowed: true, retryAfterSec: 0 });
    vi.mocked(widgetRateLimiter.checkDefault).mockReturnValue({ allowed: true, retryAfterSec: 0 });
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(AUTH as any);
    vi.mocked(WidgetService.attachmentsEnabled).mockReturnValue(true);
    vi.mocked(WidgetService.createTicketWithAttachments).mockResolvedValue({
      ticket: { id: 'ticket-1' },
      attachments: [{ id: 'att-1', originalName: 'screen.png', mimeType: 'image/png', url: 'https://example.invalid/a' }],
    } as any);
  });

  it('parses image files and creates the ticket through the atomic attachment path', async () => {
    const form = new FormData();
    form.append('description', 'Checkout fails');
    form.append('isPrivate', 'true');
    form.append('context', JSON.stringify({ url: 'https://app.example/checkout' }));
    form.append('files', new File([Buffer.from('png')], 'screen.png', { type: 'image/png' }));

    const res = await createHttpApp().request('/api/widget/tickets', {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(201);
    expect(WidgetService.createTicketWithAttachments).toHaveBeenCalledOnce();
    const [, , draft, files] = vi.mocked(WidgetService.createTicketWithAttachments).mock.calls[0]!;
    expect(draft).toMatchObject({
      description: 'Checkout fails',
      isPrivate: true,
      context: { url: 'https://app.example/checkout' },
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      mimeType: 'image/png',
      filename: 'screen.png',
      originalName: 'screen.png',
    });
    expect(Buffer.isBuffer(files[0]!.buffer)).toBe(true);
    expect(WidgetAutoAssign.autoAssignTicket).toHaveBeenCalledWith('proj-1', 'ticket-1', 'wu-1', { skipGuard: true });
    expect(await res.json()).toMatchObject({ ticket: { id: 'ticket-1' }, attachments: [{ id: 'att-1' }] });
  });

  it('rejects multipart uploads before reading when the kill switch is off', async () => {
    vi.mocked(WidgetService.attachmentsEnabled).mockReturnValue(false);
    const form = new FormData();
    form.append('description', 'Checkout fails');
    form.append('files', new File([Buffer.from('png')], 'screen.png', { type: 'image/png' }));

    const res = await createHttpApp().request('/api/widget/tickets', {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'attachments_disabled' });
    expect(WidgetService.createTicketWithAttachments).not.toHaveBeenCalled();
    expect(WidgetAutoAssign.autoAssignTicket).not.toHaveBeenCalled();
  });
});
