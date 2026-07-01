/**
 * Service-level tests for attachConversationImage + toPublicChatImage.
 *
 * Critical assertion: the returned PublicChatImage NEVER includes
 * storageKey / storageProvider / originalStorageKey / modelStorageKey etc.
 *
 * Uses vi.mock to stub db (two-call chain pattern from WidgetService.widgetChatImage.test.ts)
 * and WidgetService.storeWidgetChatImage.
 *
 * The mock covers two sequential db.select() calls:
 *   1st: getConversationOwned → .from().where().limit(1) → [conv] | []
 *   2nd: count query          → .from().where()          → [{count}]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock state
// ---------------------------------------------------------------------------

const mockStoreWidgetChatImage = vi.hoisted(() => vi.fn());
const mockDbSelectChain = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks — must be before imports
// ---------------------------------------------------------------------------

vi.mock('./WidgetService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./WidgetService')>();
  return {
    ...actual,
    storeWidgetChatImage: (...args: unknown[]) => mockStoreWidgetChatImage(...args),
  };
});

vi.mock('../../db/index', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelectChain(...args),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import SUT AFTER mocks
// ---------------------------------------------------------------------------

import { attachConversationImage, toPublicChatImage } from './WidgetChatService';
import { WidgetError, MAX_CHAT_IMAGES_PER_CONVERSATION } from './WidgetService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONV_ID = '11111111-1111-4111-a111-111111111111';
const PROJECT_ID = '22222222-2222-4222-a222-222222222222';
const USER_ID = '33333333-3333-4333-a333-333333333333';

const PERMS_WITH_ATTACH = new Set(['attach_image'] as const);

const STUB_FILE = {
  buffer: Buffer.from('JPEG'),
  mimeType: 'image/jpeg',
  filename: 'photo.jpg',
  originalName: 'photo.jpg',
};

/** Full ChatImageRow as returned by storeWidgetChatImage (includes storage keys). */
const STUB_FULL_ROW = {
  id: 'img-uuid-1',
  conversationId: CONV_ID,
  widgetUserId: USER_ID,
  messageId: null,
  serverId: 'ws_test',
  mimeType: 'image/jpeg',
  originalName: 'photo.jpg',
  originalStorageProvider: 'r2' as const,
  originalStorageKey: 'uploads/original/img-uuid-1.jpg',
  modelStorageProvider: 'r2' as const,
  modelStorageKey: 'uploads/model/img-uuid-1-model.jpg',
  width: 800,
  height: 600,
  createdAt: new Date('2026-06-26T00:00:00Z'),
};

const ACTIVE_CONV = {
  id: CONV_ID,
  widgetProjectId: PROJECT_ID,
  widgetUserId: USER_ID,
  status: 'active',
  createdTaskId: null,
  userTurnCount: 0,
  pendingTurnId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Set up the two sequential db.select() mocks:
 *   1st call: getConversationOwned → .from().where().limit(1) → resolves [conv] | []
 *   2nd call: count query          → .from().where()          → resolves [{count}]
 */
function setupDbMocks(convRow: object | undefined, imageCount: number) {
  mockDbSelectChain
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(convRow ? [convRow] : []),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: String(imageCount) }]),
      }),
    });
}

// ---------------------------------------------------------------------------
// toPublicChatImage unit tests
// ---------------------------------------------------------------------------

describe('toPublicChatImage', () => {
  it('maps only public fields from a full row', () => {
    const result = toPublicChatImage(STUB_FULL_ROW);
    expect(result).toEqual({
      id: 'img-uuid-1',
      mimeType: 'image/jpeg',
      originalName: 'photo.jpg',
      width: 800,
      height: 600,
    });
  });

  it('NEVER includes any storage key or provider field', () => {
    const result = toPublicChatImage(STUB_FULL_ROW) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty('originalStorageKey');
    expect(result).not.toHaveProperty('originalStorageProvider');
    expect(result).not.toHaveProperty('modelStorageKey');
    expect(result).not.toHaveProperty('modelStorageProvider');
    expect(result).not.toHaveProperty('storageKey');
    expect(result).not.toHaveProperty('storageProvider');
    expect(result).not.toHaveProperty('serverId');
    expect(result).not.toHaveProperty('conversationId');
    expect(result).not.toHaveProperty('widgetUserId');
    expect(result).not.toHaveProperty('messageId');
  });

  it('coerces null originalName to null', () => {
    const result = toPublicChatImage({ ...STUB_FULL_ROW, originalName: null });
    expect(result.originalName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attachConversationImage integration tests
// ---------------------------------------------------------------------------

describe('attachConversationImage', () => {
  beforeEach(() => {
    // resetAllMocks flushes once-queues too (clearAllMocks does not).
    vi.resetAllMocks();
    mockStoreWidgetChatImage.mockResolvedValue(STUB_FULL_ROW);
  });

  it('returns PublicChatImage with no storage keys when storeWidgetChatImage succeeds', async () => {
    setupDbMocks(ACTIVE_CONV, 0);
    const result = await attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE);
    expect(result).toEqual({
      id: 'img-uuid-1',
      mimeType: 'image/jpeg',
      originalName: 'photo.jpg',
      width: 800,
      height: 600,
    });
    // Critical: no storage fields in the result
    const asRecord = result as unknown as Record<string, unknown>;
    expect(asRecord).not.toHaveProperty('originalStorageKey');
    expect(asRecord).not.toHaveProperty('originalStorageProvider');
    expect(asRecord).not.toHaveProperty('modelStorageKey');
    expect(asRecord).not.toHaveProperty('modelStorageProvider');
    expect(asRecord).not.toHaveProperty('serverId');
  });

  it('throws attachment_count_exceeded (400) when cap is reached, before calling storeWidgetChatImage', async () => {
    setupDbMocks(ACTIVE_CONV, MAX_CHAT_IMAGES_PER_CONVERSATION);
    await expect(
      attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE),
    ).rejects.toMatchObject({ code: 'attachment_count_exceeded', status: 400 });
    expect(mockStoreWidgetChatImage).not.toHaveBeenCalled();
  });

  it('throws conversation_not_found (404) when conversation does not exist or belongs to another user', async () => {
    setupDbMocks(undefined, 0);
    await expect(
      attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE),
    ).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
    expect(mockStoreWidgetChatImage).not.toHaveBeenCalled();
  });

  it('throws conversation_closed (409) when conversation is not active', async () => {
    // count mock is not consumed because requireWritableConversation throws first
    mockDbSelectChain.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ ...ACTIVE_CONV, status: 'closed' }]),
        }),
      }),
    });
    await expect(
      attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE),
    ).rejects.toMatchObject({ code: 'conversation_closed', status: 409 });
    expect(mockStoreWidgetChatImage).not.toHaveBeenCalled();
  });

  it('passes all arguments through to storeWidgetChatImage', async () => {
    setupDbMocks(ACTIVE_CONV, 0);
    await attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE);
    expect(mockStoreWidgetChatImage).toHaveBeenCalledOnce();
    const [pid, cid, uid, perms, file] = mockStoreWidgetChatImage.mock.calls[0]!;
    expect(pid).toBe(PROJECT_ID);
    expect(cid).toBe(CONV_ID);
    expect(uid).toBe(USER_ID);
    expect(perms).toBe(PERMS_WITH_ATTACH);
    expect(file).toBe(STUB_FILE);
  });

  it('propagates attachment_unsupported_type (400) from storeWidgetChatImage', async () => {
    setupDbMocks(ACTIVE_CONV, 0);
    mockStoreWidgetChatImage.mockRejectedValue(new WidgetError('attachment_unsupported_type', 400));
    await expect(
      attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE),
    ).rejects.toMatchObject({ code: 'attachment_unsupported_type', status: 400 });
  });

  it('propagates attachment_too_large (413) from storeWidgetChatImage', async () => {
    setupDbMocks(ACTIVE_CONV, 0);
    mockStoreWidgetChatImage.mockRejectedValue(new WidgetError('attachment_too_large', 413));
    await expect(
      attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE),
    ).rejects.toMatchObject({ code: 'attachment_too_large', status: 413 });
  });

  it('still passes when count is one below the cap', async () => {
    setupDbMocks(ACTIVE_CONV, MAX_CHAT_IMAGES_PER_CONVERSATION - 1);
    const result = await attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE);
    expect(result.id).toBe('img-uuid-1');
    expect(mockStoreWidgetChatImage).toHaveBeenCalledOnce();
  });

  it('does NOT call storeWidgetChatImage when cap is exactly at limit', async () => {
    setupDbMocks(ACTIVE_CONV, MAX_CHAT_IMAGES_PER_CONVERSATION);
    await expect(
      attachConversationImage(CONV_ID, PROJECT_ID, USER_ID, PERMS_WITH_ATTACH, STUB_FILE),
    ).rejects.toMatchObject({ code: 'attachment_count_exceeded' });
    expect(mockStoreWidgetChatImage).not.toHaveBeenCalled();
  });
});
