/**
 * TDD tests for buildTranscript image enrichment (Task 5).
 *
 * Verifies that user rows with linked widget_chat_images carry
 * `images: [{ mime, dataBase64 }]` in the transcript, using the model
 * derivative (modelStorageProvider / modelStorageKey). Rows without images
 * and non-user rows must NOT carry an `images` field.
 *
 * The db module and TaskAttachmentStorageService are both mocked so this
 * suite runs without a real Postgres connection or S3.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock state (vi.mock factories must reference hoisted refs)
// ---------------------------------------------------------------------------

const mockGetObjectBuffer = vi.hoisted(() => vi.fn());
const mockDbSelect = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

vi.mock('../../db/index', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import SUT AFTER mocks
// ---------------------------------------------------------------------------

import { buildTranscript, __setAttachmentStorageForTests } from './WidgetChatService';
import type { WidgetChatEventPayload } from '../../db/schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONV_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const MSG_ID_1 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const MSG_ID_2 = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Row constructors
// ---------------------------------------------------------------------------

const userRow = (id: string, content: string) => ({
  id,
  role: 'user' as const,
  content,
  payload: null,
});
const agentRow = (id: string, content: string) => ({
  id,
  role: 'agent' as const,
  content,
  payload: null,
});
const eventRow = (id: string, payload: WidgetChatEventPayload) => ({
  id,
  role: 'event' as const,
  content: '',
  payload,
});

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

/**
 * Set up db.select() to return `imageRows` from the .from().where() chain.
 */
function setupImageRows(
  rows: Array<{ messageId: string; modelStorageProvider: 'r2' | 's3'; modelStorageKey: string }>,
) {
  mockDbSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle: inject mock storage service, restore after each test
// ---------------------------------------------------------------------------

let restore: () => void;

beforeEach(() => {
  vi.resetAllMocks();
  restore = __setAttachmentStorageForTests({
    isConfigured: () => true,
    getObjectBuffer: mockGetObjectBuffer,
  });
});

afterEach(() => {
  restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTranscript image enrichment', () => {
  it('attaches base64 model derivative to a user row that has linked images', async () => {
    const fakeBuffer = Buffer.from('fake-jpeg-data');
    mockGetObjectBuffer.mockResolvedValue(fakeBuffer);
    setupImageRows([
      {
        messageId: MSG_ID_1,
        modelStorageProvider: 'r2',
        modelStorageKey: 'servers/ws/model/img-1.jpg',
      },
    ]);

    const result = await buildTranscript([userRow(MSG_ID_1, 'look at this')], CONV_ID);

    expect(result).toHaveLength(1);
    const entry = result[0] as { role: string; content: string; images?: unknown[] };
    expect(entry.role).toBe('user');
    expect(entry.content).toBe('look at this');
    expect(entry.images).toEqual([
      { mime: 'image/jpeg', dataBase64: fakeBuffer.toString('base64') },
    ]);
    expect(mockGetObjectBuffer).toHaveBeenCalledWith({
      storageProvider: 'r2',
      storageKey: 'servers/ws/model/img-1.jpg',
    });
  });

  it('attaches multiple images when multiple image rows are linked to a message', async () => {
    const buf1 = Buffer.from('img-bytes-1');
    const buf2 = Buffer.from('img-bytes-2');
    mockGetObjectBuffer.mockResolvedValueOnce(buf1).mockResolvedValueOnce(buf2);
    setupImageRows([
      { messageId: MSG_ID_1, modelStorageProvider: 'r2', modelStorageKey: 'servers/ws/model/img-a.jpg' },
      { messageId: MSG_ID_1, modelStorageProvider: 'r2', modelStorageKey: 'servers/ws/model/img-b.jpg' },
    ]);

    const result = await buildTranscript([userRow(MSG_ID_1, 'two images')], CONV_ID);

    const entry = result[0] as any;
    expect(entry.images).toHaveLength(2);
    expect(entry.images[0].dataBase64).toBe(buf1.toString('base64'));
    expect(entry.images[1].dataBase64).toBe(buf2.toString('base64'));
  });

  it('user row without linked images has no images field', async () => {
    setupImageRows([]);

    const result = await buildTranscript([userRow(MSG_ID_1, 'text only')], CONV_ID);

    expect(result).toHaveLength(1);
    const entry = result[0] as any;
    expect(entry.role).toBe('user');
    expect(entry.images).toBeUndefined();
    expect(mockGetObjectBuffer).not.toHaveBeenCalled();
  });

  it('agent rows never carry an images field', async () => {
    // No user rows → db.select() for images should NOT be called at all
    const result = await buildTranscript([agentRow(MSG_ID_2, 'hello there')], CONV_ID);

    expect(result).toHaveLength(1);
    const entry = result[0] as any;
    expect(entry.role).toBe('agent');
    expect(entry.images).toBeUndefined();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockGetObjectBuffer).not.toHaveBeenCalled();
  });

  it('event rows never carry an images field', async () => {
    const result = await buildTranscript(
      [eventRow(MSG_ID_2, { kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' })],
      CONV_ID,
    );

    expect(result).toHaveLength(1);
    const entry = result[0] as any;
    expect(entry.role).toBe('event');
    expect(entry.images).toBeUndefined();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockGetObjectBuffer).not.toHaveBeenCalled();
  });

  it('skips image enrichment entirely when conversationId is not provided (pure sync compat path)', async () => {
    // No conversationId → should return the base transcript without touching db or storage
    const result = await buildTranscript([userRow(MSG_ID_1, 'pure path')]);

    expect(result).toHaveLength(1);
    expect((result[0] as any).images).toBeUndefined();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockGetObjectBuffer).not.toHaveBeenCalled();
  });

  it('emits an image-only user row (empty content) with its images', async () => {
    const fakeBuffer = Buffer.from('img-only-bytes');
    mockGetObjectBuffer.mockResolvedValue(fakeBuffer);
    setupImageRows([
      { messageId: MSG_ID_1, modelStorageProvider: 'r2', modelStorageKey: 'servers/ws/model/img-only.jpg' },
    ]);

    const result = await buildTranscript([userRow(MSG_ID_1, '')], CONV_ID);

    expect(result).toHaveLength(1);
    const entry = result[0] as any;
    expect(entry.role).toBe('user');
    expect(entry.content).toBe('');
    expect(entry.images).toHaveLength(1);
    expect(entry.images[0].dataBase64).toBe(fakeBuffer.toString('base64'));
    expect(mockGetObjectBuffer).toHaveBeenCalledWith({
      storageProvider: 'r2',
      storageKey: 'servers/ws/model/img-only.jpg',
    });
  });

  it('does NOT emit an empty-content user row with no linked images', async () => {
    setupImageRows([]); // No images for MSG_ID_1

    const result = await buildTranscript([userRow(MSG_ID_1, '')], CONV_ID);

    expect(result).toHaveLength(0);
  });

  it('mixed conversation: only user rows with images are enriched', async () => {
    const fakeBuffer = Buffer.from('jpeg-bytes');
    mockGetObjectBuffer.mockResolvedValue(fakeBuffer);
    // Only MSG_ID_1 has images; MSG_ID_2 does not
    setupImageRows([
      { messageId: MSG_ID_1, modelStorageProvider: 'r2', modelStorageKey: 'servers/ws/model/img-1.jpg' },
    ]);

    const result = await buildTranscript([
      userRow(MSG_ID_1, 'with image'),
      agentRow('agent-id-1', 'agent reply'),
      userRow(MSG_ID_2, 'no image here'),
    ], CONV_ID);

    expect(result).toHaveLength(3);
    const userWithImg = result[0] as any;
    const agentEntry = result[1] as any;
    const userNoImg = result[2] as any;

    expect(userWithImg.images).toEqual([{ mime: 'image/jpeg', dataBase64: fakeBuffer.toString('base64') }]);
    expect(agentEntry.images).toBeUndefined();
    expect(userNoImg.images).toBeUndefined();
  });
});
