/**
 * sendUserMessage with imageIds: validates count cap, ownership, already-linked
 * check — all BEFORE the message INSERT. Links images after insert.
 * loadChatImagesForMessages: batch-loads PublicChatImage[] keyed by messageId.
 *
 * Uses vi.mock to stub db. All sequential db.select() calls use
 * mockReturnValueOnce so each call returns its own response.
 *
 * Critical TDD constraint: validate BEFORE insert — a failed image-ref
 * validation must NOT trigger db.insert(widgetChatMessages).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock state
// ---------------------------------------------------------------------------

const mockDbSelectChain = vi.hoisted(() => vi.fn());
const mockDbInsert = vi.hoisted(() => vi.fn());
const mockDbUpdate = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks — must be before imports
// ---------------------------------------------------------------------------

vi.mock('./ServerService', () => ({
  serverTokenFetch: vi.fn(),
}));

vi.mock('../../db/index', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelectChain(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
    delete: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import SUT AFTER mocks
// ---------------------------------------------------------------------------

import { sendUserMessage, loadChatImagesForMessages, subscribeToConversation } from './WidgetChatService';
import { MAX_CHAT_IMAGES_PER_MESSAGE, WidgetError } from './WidgetService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONV_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const IMG_ID_1 = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
const IMG_ID_2 = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
const MSG_ID = 'ffffffff-ffff-4fff-ffff-ffffffffffff';

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

const AGENTLESS_PROJECT = {
  id: PROJECT_ID,
  serverId: 'ws_test',
  workspaceProjectId: null,
  widgetChatAgentEntityId: null, // agentless → no turn dispatch
};

const STUB_MESSAGE = {
  id: MSG_ID,
  conversationId: CONV_ID,
  role: 'user',
  content: 'hello',
  payload: null,
  turnId: null,
  seq: null,
  createdAt: new Date(),
};

const STUB_IMAGE_ONLY_MESSAGE = {
  ...STUB_MESSAGE,
  content: '',
};

const STUB_COLLECT_PROMPT = {
  id: 'gggggggg-gggg-4ggg-gggg-gggggggggggg',
  conversationId: CONV_ID,
  role: 'event',
  content: '',
  payload: { kind: 'collect_prompt' },
  turnId: null,
  seq: null,
  createdAt: new Date(),
};

/**
 * Returns a db.select mock builder that resolves without .limit() (used for
 * array-returning queries like image validation).
 */
function noLimitSelect(resolvedRows: object[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(resolvedRows),
    }),
  };
}

/**
 * Returns a db.select mock builder that resolves through .limit() (used for
 * queries that destructure the first element: .select().from().where().limit(1)).
 */
function limitedSelect(resolvedRows: object[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(resolvedRows),
      }),
    }),
  };
}

/**
 * Returns a db.insert mock builder that resolves through .values().returning().
 */
function insertBuilder(resolvedRows: object[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(resolvedRows),
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
}

/**
 * Returns a db.update mock builder that resolves through .set().where().
 */
function updateBuilder() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowCount: 1 }),
    }),
  };
}

/**
 * Setup db mocks for a happy-path sendUserMessage with imageIds.
 *
 * Call sequence (agentless project, no existing collect_prompt):
 *   select 1: getConversationOwned → [ACTIVE_CONV]
 *   select 2: getChatProject       → [AGENTLESS_PROJECT]
 *   select 3: image validation     → validImageRows (array, no .limit())
 *   insert 1: insert message       → [STUB_MESSAGE]
 *   update 1: update conv turn count
 *   update 2: link images
 *   select 4: ensureCollectPrompt check → [] (no existing)
 *   insert 2: insert collect_prompt → [STUB_COLLECT_PROMPT]
 */
function setupHappyPath(imageRows: object[]) {
  mockDbSelectChain
    .mockReturnValueOnce(limitedSelect([ACTIVE_CONV]))  // getConversationOwned
    .mockReturnValueOnce(limitedSelect([AGENTLESS_PROJECT]))  // getChatProject
    .mockReturnValueOnce(noLimitSelect(imageRows))  // image validation
    .mockReturnValueOnce(limitedSelect([]));  // ensureCollectPrompt: no existing

  mockDbInsert
    .mockReturnValueOnce(insertBuilder([STUB_MESSAGE]))  // insert message
    .mockReturnValueOnce(insertBuilder([STUB_COLLECT_PROMPT]));  // insert collect_prompt

  mockDbUpdate
    .mockReturnValueOnce(updateBuilder())  // update conversation turn count
    .mockReturnValueOnce(updateBuilder());  // link images (UPDATE widget_chat_images)
}

/**
 * Setup db mocks for a sendUserMessage call that should fail at image
 * validation (imageRows count != imageIds.length).
 *
 * Call sequence:
 *   select 1: getConversationOwned → [ACTIVE_CONV]
 *   select 2: getChatProject       → [AGENTLESS_PROJECT]
 *   select 3: image validation     → imageRows (count mismatch → throw)
 *   (db.insert and db.update NOT called)
 */
function setupInvalidImagePath(imageRows: object[]) {
  mockDbSelectChain
    .mockReturnValueOnce(limitedSelect([ACTIVE_CONV]))
    .mockReturnValueOnce(limitedSelect([AGENTLESS_PROJECT]))
    .mockReturnValueOnce(noLimitSelect(imageRows));
}

// ---------------------------------------------------------------------------
// Tests: count cap
// ---------------------------------------------------------------------------

describe('sendUserMessage — imageIds count cap', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it(`throws attachment_count_exceeded (400) when imageIds.length > MAX (${MAX_CHAT_IMAGES_PER_MESSAGE})`, async () => {
    const ids = Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE + 1 }, (_, i) => `id-${i}`);

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'too many', ids),
    ).rejects.toMatchObject({ code: 'attachment_count_exceeded', status: 400 });
  });

  it('does NOT call db.insert (no message inserted) when count cap is exceeded', async () => {
    const ids = Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE + 1 }, (_, i) => `id-${i}`);

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'too many', ids),
    ).rejects.toMatchObject({ code: 'attachment_count_exceeded' });

    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('does NOT call db.select (no queries) when count cap is exceeded', async () => {
    const ids = Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE + 1 }, (_, i) => `id-${i}`);

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'too many', ids),
    ).rejects.toMatchObject({ code: 'attachment_count_exceeded' });

    expect(mockDbSelectChain).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: image ref validation (validate BEFORE insert)
// ---------------------------------------------------------------------------

describe('sendUserMessage — imageIds ref validation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws invalid_image_ref (400) when query returns fewer rows than imageIds (wrong conversationId / userId / already-linked)', async () => {
    setupInvalidImagePath([]); // 0 rows returned for 1 requested id

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'bad image', [IMG_ID_1]),
    ).rejects.toMatchObject({ code: 'invalid_image_ref', status: 400 });
  });

  it('does NOT call db.insert (no message row) when image ref is invalid', async () => {
    setupInvalidImagePath([]); // validation fails

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'bad image', [IMG_ID_1]),
    ).rejects.toMatchObject({ code: 'invalid_image_ref' });

    // The message INSERT must NOT have been called.
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('does NOT call db.update (no image linking) when image ref is invalid', async () => {
    setupInvalidImagePath([]);

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'bad image', [IMG_ID_1]),
    ).rejects.toMatchObject({ code: 'invalid_image_ref' });

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('throws invalid_image_ref when SOME but not ALL ids are valid (partial match)', async () => {
    // 2 requested, only 1 returned
    setupInvalidImagePath([{ id: IMG_ID_1 }]);

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'partial', [IMG_ID_1, IMG_ID_2]),
    ).rejects.toMatchObject({ code: 'invalid_image_ref', status: 400 });

    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: happy path — images linked after insert
// ---------------------------------------------------------------------------

describe('sendUserMessage — imageIds happy path', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls db.update(widgetChatImages) with the new messageId when imageIds are valid', async () => {
    setupHappyPath([{ id: IMG_ID_1 }]);

    const msg = await sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'with image', [IMG_ID_1]);

    expect(msg.id).toBe(MSG_ID);

    // There must be exactly 2 db.update calls:
    //   1st = UPDATE widget_chat_conversations (turn count)
    //   2nd = UPDATE widget_chat_images (set messageId)
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
    const updateCalls = mockDbUpdate.mock.calls;
    // One of them must be called with widgetChatImages (can't easily inspect the table arg
    // because it's the Drizzle table object, but we can confirm there are exactly 2 updates
    // and the second one sets messageId).
    const secondUpdateChain = mockDbUpdate.mock.results[1]!.value as ReturnType<typeof updateBuilder>;
    const setCalls = (secondUpdateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]![0]).toMatchObject({ messageId: MSG_ID });
  });

  it('returns the inserted message row', async () => {
    setupHappyPath([{ id: IMG_ID_1 }]);

    const msg = await sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'with image', [IMG_ID_1]);

    expect(msg).toMatchObject({ id: MSG_ID, role: 'user', content: 'hello' });
  });

  it('no imageIds: no image validation query, no image update', async () => {
    // No imageIds — skip all image-related DB calls
    mockDbSelectChain
      .mockReturnValueOnce(limitedSelect([ACTIVE_CONV]))
      .mockReturnValueOnce(limitedSelect([AGENTLESS_PROJECT]))
      .mockReturnValueOnce(limitedSelect([])); // ensureCollectPrompt: no existing

    mockDbInsert
      .mockReturnValueOnce(insertBuilder([STUB_MESSAGE]))
      .mockReturnValueOnce(insertBuilder([STUB_COLLECT_PROMPT]));

    mockDbUpdate
      .mockReturnValueOnce(updateBuilder()); // only 1 update: conversation turn count

    const msg = await sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'plain');

    expect(msg.id).toBe(MSG_ID);
    // Only 1 db.update (turn count), not 2 (no image link)
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    // Only 3 db.select calls (conv, project, ensureCollectPrompt) — no image query
    expect(mockDbSelectChain).toHaveBeenCalledTimes(3);
  });

  it('empty imageIds array: treated same as no imageIds', async () => {
    mockDbSelectChain
      .mockReturnValueOnce(limitedSelect([ACTIVE_CONV]))
      .mockReturnValueOnce(limitedSelect([AGENTLESS_PROJECT]))
      .mockReturnValueOnce(limitedSelect([])); // ensureCollectPrompt

    mockDbInsert
      .mockReturnValueOnce(insertBuilder([STUB_MESSAGE]))
      .mockReturnValueOnce(insertBuilder([STUB_COLLECT_PROMPT]));

    mockDbUpdate.mockReturnValueOnce(updateBuilder());

    const msg = await sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'empty', []);

    expect(msg.id).toBe(MSG_ID);
    expect(mockDbUpdate).toHaveBeenCalledTimes(1); // no image link update
  });
});

// ---------------------------------------------------------------------------
// Tests: loadChatImagesForMessages
// ---------------------------------------------------------------------------

describe('loadChatImagesForMessages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns empty Map without querying db when messageIds is empty', async () => {
    const map = await loadChatImagesForMessages([]);
    expect(map.size).toBe(0);
    expect(mockDbSelectChain).not.toHaveBeenCalled();
  });

  it('returns PublicChatImage[] for linked images, grouped by messageId', async () => {
    const FULL_ROW = {
      id: IMG_ID_1,
      conversationId: CONV_ID,
      widgetUserId: USER_ID,
      messageId: MSG_ID,
      serverId: 'ws_test',
      mimeType: 'image/jpeg',
      originalName: 'photo.jpg',
      originalStorageProvider: 'r2',
      originalStorageKey: 'orig/key.jpg',
      modelStorageProvider: 'r2',
      modelStorageKey: 'model/key.jpg',
      width: 800,
      height: 600,
      createdAt: new Date(),
    };

    mockDbSelectChain.mockReturnValueOnce(noLimitSelect([FULL_ROW]));

    const map = await loadChatImagesForMessages([MSG_ID]);
    const images = map.get(MSG_ID);
    expect(images).toHaveLength(1);
    expect(images![0]).toMatchObject({
      id: IMG_ID_1,
      mimeType: 'image/jpeg',
      originalName: 'photo.jpg',
      width: 800,
      height: 600,
    });
  });

  it('NEVER includes storage keys in returned PublicChatImage', async () => {
    const FULL_ROW = {
      id: IMG_ID_1,
      conversationId: CONV_ID,
      widgetUserId: USER_ID,
      messageId: MSG_ID,
      serverId: 'ws_test',
      mimeType: 'image/jpeg',
      originalName: 'photo.jpg',
      originalStorageProvider: 'r2',
      originalStorageKey: 'orig/key.jpg',
      modelStorageProvider: 'r2',
      modelStorageKey: 'model/key.jpg',
      width: 800,
      height: 600,
      createdAt: new Date(),
    };

    mockDbSelectChain.mockReturnValueOnce(noLimitSelect([FULL_ROW]));

    const map = await loadChatImagesForMessages([MSG_ID]);
    const img = map.get(MSG_ID)![0]! as unknown as Record<string, unknown>;
    expect(img).not.toHaveProperty('originalStorageKey');
    expect(img).not.toHaveProperty('originalStorageProvider');
    expect(img).not.toHaveProperty('modelStorageKey');
    expect(img).not.toHaveProperty('modelStorageProvider');
    expect(img).not.toHaveProperty('serverId');
    expect(img).not.toHaveProperty('conversationId');
    expect(img).not.toHaveProperty('widgetUserId');
    expect(img).not.toHaveProperty('messageId');
  });

  it('returns empty map entries for message ids with no linked images', async () => {
    // DB returns no rows for the given messageId
    mockDbSelectChain.mockReturnValueOnce(noLimitSelect([]));

    const map = await loadChatImagesForMessages([MSG_ID]);
    expect(map.has(MSG_ID)).toBe(false);
  });

  it('groups multiple images under the same messageId', async () => {
    const row1 = {
      id: IMG_ID_1, conversationId: CONV_ID, widgetUserId: USER_ID, messageId: MSG_ID,
      serverId: 'ws_test', mimeType: 'image/jpeg', originalName: 'a.jpg',
      originalStorageProvider: 'r2', originalStorageKey: 'orig/a.jpg',
      modelStorageProvider: 'r2', modelStorageKey: 'model/a.jpg',
      width: 100, height: 100, createdAt: new Date(),
    };
    const row2 = {
      id: IMG_ID_2, conversationId: CONV_ID, widgetUserId: USER_ID, messageId: MSG_ID,
      serverId: 'ws_test', mimeType: 'image/png', originalName: 'b.png',
      originalStorageProvider: 'r2', originalStorageKey: 'orig/b.png',
      modelStorageProvider: 'r2', modelStorageKey: 'model/b.png',
      width: 200, height: 200, createdAt: new Date(),
    };

    mockDbSelectChain.mockReturnValueOnce(noLimitSelect([row1, row2]));

    const map = await loadChatImagesForMessages([MSG_ID]);
    expect(map.get(MSG_ID)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: publish ordering — image link UPDATE must precede publish()
// ---------------------------------------------------------------------------

describe('sendUserMessage — publish ordering', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('publish fires AFTER the image-link UPDATE (db.update called twice before subscriber receives the row)', async () => {
    setupHappyPath([{ id: IMG_ID_1 }]);

    // Subscribe BEFORE calling sendUserMessage so the callback fires live
    // when publish() is called inside sendUserMessage.
    let dbUpdateCallCountAtPublish = -1;
    const unsubscribe = subscribeToConversation(CONV_ID, () => {
      // Capture how many db.update calls have been made at the instant publish fires.
      // After the fix the order is: insert → update(turnCount) → update(imageLink) → publish.
      // So this must be 2 when the subscriber is invoked.
      dbUpdateCallCountAtPublish = mockDbUpdate.mock.calls.length;
    });

    try {
      await sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, 'with image', [IMG_ID_1]);
    } finally {
      unsubscribe();
    }

    // Both db.update calls (turn count + image link) must have been made before publish.
    expect(dbUpdateCallCountAtPublish).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: image-only messages (empty text, valid imageIds)
// ---------------------------------------------------------------------------

/**
 * Setup db mocks for an image-only sendUserMessage (empty text, 1 valid image).
 *
 * Same call sequence as setupHappyPath but the insert returns STUB_IMAGE_ONLY_MESSAGE.
 */
function setupImageOnlyHappyPath(imageRows: object[]) {
  mockDbSelectChain
    .mockReturnValueOnce(limitedSelect([ACTIVE_CONV]))     // getConversationOwned
    .mockReturnValueOnce(limitedSelect([AGENTLESS_PROJECT])) // getChatProject
    .mockReturnValueOnce(noLimitSelect(imageRows))          // image validation
    .mockReturnValueOnce(limitedSelect([]));                // ensureCollectPrompt: no existing

  mockDbInsert
    .mockReturnValueOnce(insertBuilder([STUB_IMAGE_ONLY_MESSAGE])) // insert message
    .mockReturnValueOnce(insertBuilder([STUB_COLLECT_PROMPT]));    // insert collect_prompt

  mockDbUpdate
    .mockReturnValueOnce(updateBuilder())  // update conversation turn count
    .mockReturnValueOnce(updateBuilder()); // link images (UPDATE widget_chat_images)
}

describe('sendUserMessage — image-only messages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('succeeds (no error) when text is empty but a valid imageId is provided', async () => {
    setupImageOnlyHappyPath([{ id: IMG_ID_1 }]);

    const msg = await sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, '', [IMG_ID_1]);

    expect(msg.id).toBe(MSG_ID);
  });

  it('links the image to the inserted message row on an image-only send', async () => {
    setupImageOnlyHappyPath([{ id: IMG_ID_1 }]);

    await sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, '', [IMG_ID_1]);

    // Two updates: turn count + image link
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
    const secondUpdateChain = mockDbUpdate.mock.results[1]!.value as ReturnType<typeof updateBuilder>;
    const setCalls = (secondUpdateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]![0]).toMatchObject({ messageId: MSG_ID });
  });

  it('throws message_required when text is empty AND no imageIds', async () => {
    // After fix: makes 2 DB queries (conversation + project) before throwing.
    mockDbSelectChain
      .mockReturnValueOnce(limitedSelect([ACTIVE_CONV]))
      .mockReturnValueOnce(limitedSelect([AGENTLESS_PROJECT]));

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, ''),
    ).rejects.toMatchObject({ code: 'message_required', status: 400 });

    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('throws message_required when text is whitespace-only AND no imageIds', async () => {
    mockDbSelectChain
      .mockReturnValueOnce(limitedSelect([ACTIVE_CONV]))
      .mockReturnValueOnce(limitedSelect([AGENTLESS_PROJECT]));

    await expect(
      sendUserMessage(CONV_ID, PROJECT_ID, USER_ID, '   '),
    ).rejects.toMatchObject({ code: 'message_required', status: 400 });

    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});
