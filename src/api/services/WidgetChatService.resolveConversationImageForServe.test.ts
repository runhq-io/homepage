/**
 * Service-level tests for resolveConversationImageForServe.
 *
 * The function:
 *   1. Calls getConversationOwned (first db.select) — throws conversation_not_found on failure.
 *   2. Selects the image row asserting conversationId + widgetUserId (second db.select).
 *   3. Calls attachmentStorageImpl.createDownloadUrl with the original rendition keys.
 *
 * The db mock covers two sequential db.select() calls:
 *   1st: getConversationOwned → .from().where().limit(1) → [conv] | []
 *   2nd: image row select     → .from().where().limit(1) → [row]  | []
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock state
// ---------------------------------------------------------------------------

const mockDbSelectChain = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks — must be before imports
// ---------------------------------------------------------------------------

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

import { resolveConversationImageForServe, __setAttachmentStorageForTests } from './WidgetChatService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONV_ID  = '11111111-1111-4111-a111-111111111111';
const IMAGE_ID = '44444444-4444-4444-a444-444444444444';
const PROJECT_ID  = '22222222-2222-4222-a222-222222222222';
const USER_ID     = '33333333-3333-4333-a333-333333333333';
const OTHER_USER  = 'ffffffff-ffff-4fff-afff-ffffffffffff';
const PRESIGNED_URL = 'https://r2.example.com/presigned?token=abc';

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

const IMAGE_ROW = {
  originalStorageProvider: 'r2' as const,
  originalStorageKey: 'uploads/original/img-uuid-1.jpg',
  originalName: 'photo.jpg',
};

/**
 * Build a mock chain that returns result from .from().where().limit(1).
 */
function makeSelectChain(result: object | undefined) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result ? [result] : []),
      }),
    }),
  };
}

/**
 * Set up the two sequential db.select() mocks:
 *   1st: getConversationOwned → conv | not found
 *   2nd: image row            → row | not found
 */
function setupDbMocks(convRow: object | undefined, imageRow: object | undefined) {
  mockDbSelectChain
    .mockReturnValueOnce(makeSelectChain(convRow))
    .mockReturnValueOnce(makeSelectChain(imageRow));
}

// ---------------------------------------------------------------------------
// Attachment storage mock
// ---------------------------------------------------------------------------

const mockCreateDownloadUrl = vi.fn();
let restoreStorage: () => void;

beforeEach(() => {
  vi.resetAllMocks();
  restoreStorage = __setAttachmentStorageForTests({
    isConfigured: () => true,
    getObjectBuffer: vi.fn(),
    createDownloadUrl: mockCreateDownloadUrl,
  } as any);
  mockCreateDownloadUrl.mockResolvedValue(PRESIGNED_URL);
});

afterEach(() => {
  restoreStorage();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveConversationImageForServe', () => {
  it('owned image id resolves to presigned URL', async () => {
    setupDbMocks(ACTIVE_CONV, IMAGE_ROW);
    const result = await resolveConversationImageForServe(CONV_ID, IMAGE_ID, PROJECT_ID, USER_ID);
    expect(result).toBe(PRESIGNED_URL);
    expect(mockCreateDownloadUrl).toHaveBeenCalledOnce();
    expect(mockCreateDownloadUrl).toHaveBeenCalledWith(
      {
        storageProvider: 'r2',
        storageKey: 'uploads/original/img-uuid-1.jpg',
        originalName: 'photo.jpg',
      },
      { ttlSeconds: 300 },
    );
  });

  it('requests a short-lived presigned URL (ttlSeconds: 300) for chat image privacy', async () => {
    setupDbMocks(ACTIVE_CONV, IMAGE_ROW);
    await resolveConversationImageForServe(CONV_ID, IMAGE_ID, PROJECT_ID, USER_ID);
    expect(mockCreateDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: IMAGE_ROW.originalStorageKey }),
      { ttlSeconds: 300 },
    );
  });

  it('foreign conversation id → 404 (conversation_not_found)', async () => {
    // conv not found for this project+user combination
    setupDbMocks(undefined, IMAGE_ROW);
    await expect(
      resolveConversationImageForServe(CONV_ID, IMAGE_ID, PROJECT_ID, USER_ID),
    ).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
    expect(mockCreateDownloadUrl).not.toHaveBeenCalled();
  });

  it('foreign user id → conversation_not_found (ownership asserted by getConversationOwned)', async () => {
    // ACTIVE_CONV.widgetUserId === USER_ID; calling with OTHER_USER fails the
    // in-memory check inside getConversationOwned before the image query runs.
    setupDbMocks(ACTIVE_CONV, undefined);
    await expect(
      resolveConversationImageForServe(CONV_ID, IMAGE_ID, PROJECT_ID, OTHER_USER),
    ).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
    expect(mockCreateDownloadUrl).not.toHaveBeenCalled();
  });

  it('unknown image id → 404 (image_not_found)', async () => {
    // conv found, but no image row for this imageId
    setupDbMocks(ACTIVE_CONV, undefined);
    await expect(
      resolveConversationImageForServe(CONV_ID, IMAGE_ID, PROJECT_ID, USER_ID),
    ).rejects.toMatchObject({ code: 'image_not_found', status: 404 });
    expect(mockCreateDownloadUrl).not.toHaveBeenCalled();
  });

  it('storage returns null → 404 (image_not_found)', async () => {
    setupDbMocks(ACTIVE_CONV, IMAGE_ROW);
    mockCreateDownloadUrl.mockResolvedValue(null);
    await expect(
      resolveConversationImageForServe(CONV_ID, IMAGE_ID, PROJECT_ID, USER_ID),
    ).rejects.toMatchObject({ code: 'image_not_found', status: 404 });
  });
});
