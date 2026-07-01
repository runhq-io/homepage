/**
 * Route-level tests for POST /api/widget/chat/conversations/:id/images.
 *
 * Tests: 401 (no auth), 403 (anon user), 403 (no attach_image permission),
 * 400 (missing file), 400 (service errors: unsupported type / too large /
 * attachment_count_exceeded), 201 success + storage-key exclusion assertion.
 *
 * WidgetChatService.attachConversationImage is mocked — service-level
 * correctness is tested in WidgetChatService.attachConversationImage.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(),
}));
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  getServerByToken: vi.fn(),
  serverTokenFetch: vi.fn(),
}));
vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class {
    isConfigured() { return true; }
  },
}));
vi.mock('./services/WidgetAutoAssign', () => ({ autoAssignTicket: vi.fn() }));
vi.mock('./services/WidgetRateLimiter', () => ({
  widgetRateLimiter: {
    check: vi.fn().mockReturnValue({ allowed: true, retryAfterSec: 0 }),
    checkDefault: vi.fn().mockReturnValue({ allowed: true, retryAfterSec: 0 }),
  },
}));
vi.mock('./services/WidgetChatService', () => ({
  getOrCreateActiveConversation: vi.fn(),
  getActiveConversation: vi.fn(),
  getConversationOwned: vi.fn(),
  listMessages: vi.fn(),
  sendUserMessage: vi.fn(),
  forceProposal: vi.fn(),
  createTicketFromChat: vi.fn(),
  submitTicketFromConversation: vi.fn(),
  dismissProposal: vi.fn(),
  ingestTurnEvents: vi.fn(),
  subscribeToConversation: vi.fn(() => () => {}),
  attachConversationImage: vi.fn(),
}));
vi.mock('./services/WidgetService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/WidgetService')>();
  return { ...actual, authenticateWidget: vi.fn() };
});

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import * as WidgetChatService from './services/WidgetChatService';
import { widgetRateLimiter } from './services/WidgetRateLimiter';

const CONV_ID = '11111111-1111-4111-a111-111111111111';
const URL = `/api/widget/chat/conversations/${CONV_ID}/images`;

const IDENTIFIED_WITH_ATTACH = {
  projectId: 'proj-1',
  projectSlug: 'proj-1-slug',
  widgetUserId: 'wu-1',
  authenticated: true,
  permissions: new Set(['attach_image']),
  matchedRoles: [],
  authSource: 'app' as const,
};

const IDENTIFIED_NO_ATTACH = {
  ...IDENTIFIED_WITH_ATTACH,
  permissions: new Set<string>(),
};

const ANON = {
  projectId: 'proj-1',
  projectSlug: 'proj-1-slug',
  widgetUserId: undefined as unknown as string,
  authenticated: false,
  permissions: new Set<string>(),
  matchedRoles: [],
  authSource: 'anon' as const,
};

/** Build a minimal multipart request with a single file field. */
function makeFormRequest(filename = 'photo.jpg', mimeType = 'image/jpeg', bytes = Buffer.from('JPEG')) {
  const form = new FormData();
  form.append('file', new File([bytes], filename, { type: mimeType }));
  return { method: 'POST', body: form };
}

const STUB_IMAGE = {
  id: 'img-uuid-1',
  mimeType: 'image/jpeg',
  originalName: 'photo.jpg',
  width: 800,
  height: 600,
};

describe('POST /api/widget/chat/conversations/:id/images', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(widgetRateLimiter.checkDefault).mockReturnValue({ allowed: true, retryAfterSec: 0 });
  });

  // ---- Auth gating ----------------------------------------------------------

  it('401 when authenticateWidget returns null', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null as any);
    const res = await createHttpApp().request(URL, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(WidgetChatService.attachConversationImage).not.toHaveBeenCalled();
  });

  it('403 for anonymous (unidentified) callers', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(ANON as any);
    const res = await createHttpApp().request(URL, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(WidgetChatService.attachConversationImage).not.toHaveBeenCalled();
  });

  it('403 when attach_image permission is absent', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED_NO_ATTACH as any);
    const res = await createHttpApp().request(URL, makeFormRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'attach_image_permission_required' });
    expect(WidgetChatService.attachConversationImage).not.toHaveBeenCalled();
  });

  // ---- Multipart validation ------------------------------------------------

  it('400 when no file field is present in the form', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED_WITH_ATTACH as any);
    const form = new FormData();
    form.append('other', 'value');
    const res = await createHttpApp().request(URL, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'file_required' });
    expect(WidgetChatService.attachConversationImage).not.toHaveBeenCalled();
  });

  // ---- Service error mapping -----------------------------------------------

  it.each([
    ['attachment_unsupported_type', 400, 'image/svg+xml'],
    ['attachment_too_large', 413, 'image/png'],
  ])('maps %s → %d from service', async (code, status) => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED_WITH_ATTACH as any);
    vi.mocked(WidgetChatService.attachConversationImage).mockRejectedValue(
      new WidgetService.WidgetError(code as any, status),
    );
    const res = await createHttpApp().request(URL, makeFormRequest());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it('400 attachment_count_exceeded when per-conversation cap is reached', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED_WITH_ATTACH as any);
    vi.mocked(WidgetChatService.attachConversationImage).mockRejectedValue(
      new WidgetService.WidgetError('attachment_count_exceeded', 400),
    );
    const res = await createHttpApp().request(URL, makeFormRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'attachment_count_exceeded' });
  });

  // ---- Success + storage-key exclusion assertion ---------------------------

  it('201 returns { image } with id/mimeType/originalName/width/height — NO storageKey or storageProvider', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED_WITH_ATTACH as any);
    vi.mocked(WidgetChatService.attachConversationImage).mockResolvedValue(STUB_IMAGE);
    const res = await createHttpApp().request(URL, makeFormRequest('photo.jpg', 'image/jpeg'));
    expect(res.status).toBe(201);
    const body = await res.json() as { image: Record<string, unknown> };
    expect(body.image).toEqual(STUB_IMAGE);
    // The critical assertion: storage keys must NEVER appear in the response
    expect(body.image).not.toHaveProperty('storageKey');
    expect(body.image).not.toHaveProperty('storageProvider');
    expect(body.image).not.toHaveProperty('originalStorageKey');
    expect(body.image).not.toHaveProperty('originalStorageProvider');
    expect(body.image).not.toHaveProperty('modelStorageKey');
    expect(body.image).not.toHaveProperty('modelStorageProvider');
  });

  it('passes file buffer, mimeType, filename, and originalName to attachConversationImage', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED_WITH_ATTACH as any);
    vi.mocked(WidgetChatService.attachConversationImage).mockResolvedValue(STUB_IMAGE);
    await createHttpApp().request(URL, makeFormRequest('shot.png', 'image/png', Buffer.from('PNG_DATA')));
    const [convId, projectId, widgetUserId, , file] =
      vi.mocked(WidgetChatService.attachConversationImage).mock.calls[0]!;
    expect(convId).toBe(CONV_ID);
    expect(projectId).toBe('proj-1');
    expect(widgetUserId).toBe('wu-1');
    expect(file.mimeType).toBe('image/png');
    expect(file.filename).toBe('shot.png');
    expect(file.originalName).toBe('shot.png');
    expect(Buffer.isBuffer(file.buffer)).toBe(true);
  });

  // ---- Rate limiting -------------------------------------------------------

  it('429 when rate limit is exceeded', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED_WITH_ATTACH as any);
    vi.mocked(widgetRateLimiter.checkDefault).mockReturnValue({ allowed: false, retryAfterSec: 60 });
    const res = await createHttpApp().request(URL, makeFormRequest());
    expect(res.status).toBe(429);
    expect(WidgetChatService.attachConversationImage).not.toHaveBeenCalled();
  });
});
