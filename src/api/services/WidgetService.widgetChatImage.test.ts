/**
 * Tests for storeWidgetChatImage — widget chat image storage service.
 *
 * Uses module-level vi.mock() to stub the external IO that WidgetService
 * depends on (InjectionGuardService, TaskAttachmentStorageService, db).
 * This mirrors the pattern used by WidgetService.assign.test.ts
 * (vi.mock for external services) extended to cover storage and DB.
 *
 * resizeForModel runs for real — a 4×4 PNG synthesised by sharp provides a
 * valid decode/encode path without mocking the image pipeline.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import type { ChatImageRow } from '../../db/schema';

// ---------------------------------------------------------------------------
// Hoist mock state so factories can reference it
// ---------------------------------------------------------------------------

const mockCheckTicket = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ safe: true, reasons: [] }),
);

const mockStoreUpload = vi.hoisted(() => vi.fn());
const mockDeleteStoredObject = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

// db.select chain: called twice per happy path — once for project lookup
// (returns stub project), once for conversation count query.
const mockDbSelectChain = vi.hoisted(() => vi.fn());
const mockDbInsertChain = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('./InjectionGuardService', () => ({
  checkTicket: mockCheckTicket,
}));

vi.mock('./TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: vi.fn().mockImplementation(() => ({
    isConfigured: () => true,
    storeUpload: (...args: Parameters<typeof mockStoreUpload>) => mockStoreUpload(...args),
    deleteStoredObject: (...args: Parameters<typeof mockDeleteStoredObject>) =>
      mockDeleteStoredObject(...args),
  })),
}));

vi.mock('../../db/index', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelectChain(...args),
    insert: (...args: unknown[]) => mockDbInsertChain(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import SUT AFTER mocks are set up
// ---------------------------------------------------------------------------

import {
  storeWidgetChatImage,
  canAttachImages,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  MAX_CHAT_IMAGES_PER_CONVERSATION,
  WidgetError,
} from './WidgetService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = '00000000-0000-4000-a000-000000000000';
const CONV_ID = '00000000-0000-4000-a000-000000000001';
const WIDGET_USER_ID = '00000000-0000-4000-a000-000000000002';
const SERVER_ID = 'ws_test';

const STUB_PROJECT = {
  id: PROJECT_ID,
  name: 'Test Project',
  slug: 'test',
  serverId: SERVER_ID,
  widgetPosition: 'bottom-right',
  widgetLanguage: 'en',
  isPublic: true,
  widgetLoginUrl: null,
  allowedOrigins: null,
  autoRecognizeRunhqMembers: false,
  widgetAgentAssignmentEnabled: false,
  channelId: 'ch_test',
  widgetChatAgentEntityId: null,
};

const STUB_ROW: ChatImageRow = {
  id: '00000000-0000-4000-a000-00000000ffff',
  conversationId: CONV_ID,
  widgetUserId: WIDGET_USER_ID,
  messageId: null,
  serverId: SERVER_ID,
  mimeType: 'image/png',
  originalName: null,
  originalStorageProvider: 'r2',
  originalStorageKey: 'servers/ws_test/widget-chat/original-1.png',
  modelStorageProvider: 'r2',
  modelStorageKey: 'servers/ws_test/widget-chat/model-1.jpg',
  width: 4,
  height: 4,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

/** 4 × 4 PNG synthesised by sharp — valid, so resizeForModel runs for real. */
let REAL_PNG: Buffer;
beforeAll(async () => {
  REAL_PNG = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
});

function makeFile(over: Partial<{ buffer: Buffer; mimeType: string; filename: string }> = {}) {
  return {
    get buffer() {
      return REAL_PNG;
    },
    mimeType: 'image/png' as string,
    filename: 'photo.png',
    ...over,
  };
}

/** Permissions set that grants attach_image. */
const WITH_ATTACH = new Set<'attach_image'>(['attach_image']);
/** Permissions set without attach_image. */
const NO_ATTACH = new Set<never>();

// ---------------------------------------------------------------------------
// Default db chain helpers — set up per-test via beforeEach
// ---------------------------------------------------------------------------

/**
 * Build a chain mock for db.select() that handles two sequential calls:
 *   1st: project lookup → .from().where().limit(1) resolves to [project]
 *   2nd: count query   → .from().where()           resolves to [{count}]
 */
function setupSelectMocks(projectResult: unknown[] = [STUB_PROJECT], count = 0) {
  mockDbSelectChain
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(projectResult),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: String(count) }]),
      }),
    });
}

function setupInsertMock(result: ChatImageRow[] = [STUB_ROW]) {
  mockDbInsertChain.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result),
    }),
  });
}

function setupStoreMocks(
  originalKey = STUB_ROW.originalStorageKey,
  modelKey = STUB_ROW.modelStorageKey,
) {
  let callCount = 0;
  mockStoreUpload.mockImplementation(async () => {
    callCount++;
    return callCount === 1
      ? { storageProvider: 'r2', storageKey: originalKey }
      : { storageProvider: 'r2', storageKey: modelKey };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset checkTicket to the safe default
  mockCheckTicket.mockResolvedValue({ safe: true, reasons: [] });
  mockDeleteStoredObject.mockResolvedValue(undefined);
  // Default happy-path setup
  setupSelectMocks();
  setupInsertMock();
  setupStoreMocks();
});

const BASE_PARAMS = {
  projectId: PROJECT_ID,
  conversationId: CONV_ID,
  widgetUserId: WIDGET_USER_ID,
  permissions: WITH_ATTACH,
} as const;

// ---------------------------------------------------------------------------
// Tests: canAttachImages
// ---------------------------------------------------------------------------

describe('canAttachImages', () => {
  it('returns true when attach_image is present', () => {
    expect(canAttachImages(PROJECT_ID, WITH_ATTACH)).toBe(true);
  });

  it('returns false when attach_image is absent', () => {
    expect(canAttachImages(PROJECT_ID, NO_ATTACH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: RBAC rejection
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — RBAC rejection', () => {
  it('throws attach_image_permission_required (403) when attach_image permission is absent', async () => {
    await expect(
      storeWidgetChatImage(PROJECT_ID, CONV_ID, WIDGET_USER_ID, NO_ATTACH, makeFile()),
    ).rejects.toMatchObject({ code: 'attach_image_permission_required', status: 403 });
  });

  it('does not call InjectionGuardService or storeUpload when attach_image is absent', async () => {
    await expect(
      storeWidgetChatImage(PROJECT_ID, CONV_ID, WIDGET_USER_ID, NO_ATTACH, makeFile()),
    ).rejects.toMatchObject({ code: 'attach_image_permission_required' });
    expect(mockCheckTicket).not.toHaveBeenCalled();
    expect(mockStoreUpload).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: happy path
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — happy path', () => {
  it('returns the inserted row', async () => {
    const row = await storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile());
    expect(row).toBe(STUB_ROW);
  });

  it('calls storeUpload exactly twice (original + model derivative)', async () => {
    await storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile());
    expect(mockStoreUpload).toHaveBeenCalledTimes(2);
  });

  it('inserts the row with messageId null', async () => {
    await storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile());
    const insertValues = vi.mocked(mockDbInsertChain).mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(insertValues?.messageId).toBeNull();
  });

  it('passes ownerType widget_chat_message to both store calls', async () => {
    await storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile());
    for (const call of vi.mocked(mockStoreUpload).mock.calls) {
      expect(call[0].ownerType).toBe('widget_chat_message');
    }
  });

  it('first storeUpload call carries the original mime', async () => {
    await storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile());
    const firstCall = vi.mocked(mockStoreUpload).mock.calls[0]![0];
    expect(firstCall.mimeType).toBe('image/png');
  });

  it('second storeUpload call carries image/jpeg (model derivative)', async () => {
    await storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile());
    const secondCall = vi.mocked(mockStoreUpload).mock.calls[1]![0];
    expect(secondCall.mimeType).toBe('image/jpeg');
  });
});

// ---------------------------------------------------------------------------
// Tests: ordering — guard MUST run before any storage
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — guard-before-store ordering', () => {
  it('checkTicket (injection guard) is called before storeUpload', async () => {
    const callOrder: string[] = [];
    mockCheckTicket.mockImplementation(async () => {
      callOrder.push('guard');
      return { safe: true, reasons: [] };
    });
    mockStoreUpload.mockImplementation(async () => {
      callOrder.push('store');
      return { storageProvider: 'r2', storageKey: 'key' };
    });
    await storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile());
    expect(callOrder[0]).toBe('guard');
    expect(callOrder.indexOf('guard')).toBeLessThan(callOrder.indexOf('store'));
  });
});

// ---------------------------------------------------------------------------
// Tests: type + size rejections
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — type rejection', () => {
  it('throws attachment_unsupported_type (400) for image/svg+xml', async () => {
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile({ mimeType: 'image/svg+xml' })),
    ).rejects.toMatchObject({ code: 'attachment_unsupported_type', status: 400 });
    expect(mockStoreUpload).not.toHaveBeenCalled();
    expect(mockCheckTicket).not.toHaveBeenCalled();
  });

  it('throws attachment_unsupported_type (400) for text/plain', async () => {
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile({ mimeType: 'text/plain' })),
    ).rejects.toMatchObject({ code: 'attachment_unsupported_type', status: 400 });
  });
});

describe('storeWidgetChatImage — size rejection', () => {
  it('throws attachment_too_large (413) when buffer exceeds 5MB', async () => {
    const bigBuffer = Buffer.alloc(5 * 1024 * 1024 + 1);
    bigBuffer[0] = 0x89; bigBuffer[1] = 0x50; bigBuffer[2] = 0x4e; bigBuffer[3] = 0x47;
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, { buffer: bigBuffer, mimeType: 'image/png', filename: 'big.png' }),
    ).rejects.toMatchObject({ code: 'attachment_too_large', status: 413 });
    expect(mockStoreUpload).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: count limit rejections
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — count limits', () => {
  it(`throws attachment_count_exceeded when conversation already has ${MAX_CHAT_IMAGES_PER_CONVERSATION} images`, async () => {
    // vi.clearAllMocks() does NOT clear the mockReturnValueOnce queue — only call history.
    // Reset the select chain specifically so the Once queue from beforeEach is flushed
    // before we enqueue project + count=5.
    mockDbSelectChain.mockReset();
    setupSelectMocks([STUB_PROJECT], MAX_CHAT_IMAGES_PER_CONVERSATION);
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile()),
    ).rejects.toMatchObject({ code: 'attachment_count_exceeded', status: 400 });
    expect(mockCheckTicket).not.toHaveBeenCalled();
    expect(mockStoreUpload).not.toHaveBeenCalled();
  });

  it(`exported MAX_CHAT_IMAGES_PER_MESSAGE is ${MAX_CHAT_IMAGES_PER_MESSAGE} and MAX_CHAT_IMAGES_PER_CONVERSATION is ${MAX_CHAT_IMAGES_PER_CONVERSATION}`, () => {
    expect(MAX_CHAT_IMAGES_PER_MESSAGE).toBe(3);
    expect(MAX_CHAT_IMAGES_PER_CONVERSATION).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tests: injection guard rejections
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — injection guard rejections', () => {
  it('throws attachment_rejected (400) when guard says unsafe', async () => {
    mockCheckTicket.mockResolvedValue({ safe: false, reasons: ['prompt_injection'] });
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile()),
    ).rejects.toMatchObject({ code: 'attachment_rejected', status: 400 });
    expect(mockStoreUpload).not.toHaveBeenCalled();
  });

  it('throws attachment_review_unavailable (503) when guard is unavailable', async () => {
    mockCheckTicket.mockResolvedValue({ safe: false, reasons: ['guard_unavailable'], unavailable: true });
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile()),
    ).rejects.toMatchObject({ code: 'attachment_review_unavailable', status: 503 });
    expect(mockStoreUpload).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: cleanup on model-derivative store failure
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — cleanup on derivative store failure', () => {
  it('deletes the original if model-derivative store throws', async () => {
    const ORIG_KEY = 'servers/ws_test/original.png';
    let firstStoreDone = false;
    mockStoreUpload.mockImplementation(async () => {
      if (!firstStoreDone) {
        firstStoreDone = true;
        return { storageProvider: 'r2', storageKey: ORIG_KEY };
      }
      throw new Error('model upload failed');
    });
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile()),
    ).rejects.toThrow('model upload failed');
    expect(mockDeleteStoredObject).toHaveBeenCalledOnce();
    expect(mockDeleteStoredObject.mock.calls[0]![0]).toMatchObject({
      storageProvider: 'r2',
      storageKey: ORIG_KEY,
    });
  });

  it('does not call deleteStoredObject when guard rejects (nothing stored yet)', async () => {
    mockCheckTicket.mockResolvedValue({ safe: false, reasons: [] });
    await expect(
      storeWidgetChatImage(BASE_PARAMS.projectId, BASE_PARAMS.conversationId, BASE_PARAMS.widgetUserId, BASE_PARAMS.permissions, makeFile()),
    ).rejects.toMatchObject({ code: 'attachment_rejected' });
    expect(mockDeleteStoredObject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: WidgetError instanceof check (not WidgetChatImageError)
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — error class', () => {
  it('RBAC rejection throws WidgetError (not a custom subclass)', async () => {
    await expect(
      storeWidgetChatImage(PROJECT_ID, CONV_ID, WIDGET_USER_ID, NO_ATTACH, makeFile()),
    ).rejects.toBeInstanceOf(WidgetError);
  });
});

// ---------------------------------------------------------------------------
// Tests: attachments kill-switch (WIDGET_ATTACHMENTS_ENABLED=false)
// ---------------------------------------------------------------------------

describe('storeWidgetChatImage — attachments kill-switch', () => {
  const ORIGINAL_ENV = process.env.WIDGET_ATTACHMENTS_ENABLED;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.WIDGET_ATTACHMENTS_ENABLED;
    else process.env.WIDGET_ATTACHMENTS_ENABLED = ORIGINAL_ENV;
  });

  it('throws attachments_disabled (403) when WIDGET_ATTACHMENTS_ENABLED=false', async () => {
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'false';
    await expect(
      storeWidgetChatImage(PROJECT_ID, CONV_ID, WIDGET_USER_ID, WITH_ATTACH, makeFile()),
    ).rejects.toMatchObject({ code: 'attachments_disabled', status: 403 });
  });

  it('does not call InjectionGuardService or storeUpload when kill-switch is active', async () => {
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'false';
    await expect(
      storeWidgetChatImage(PROJECT_ID, CONV_ID, WIDGET_USER_ID, WITH_ATTACH, makeFile()),
    ).rejects.toMatchObject({ code: 'attachments_disabled' });
    expect(mockCheckTicket).not.toHaveBeenCalled();
    expect(mockStoreUpload).not.toHaveBeenCalled();
  });
});
