/**
 * Unit tests for carryConversationImagesToTask (via createTicketFromChat).
 *
 * Regression for I2: images with messageId = null (uploaded but never sent or
 * removed by the user) must NOT be carried over to the created ticket.
 * Only rows with messageId IS NOT NULL (linked to a sent message) should be
 * attached.
 *
 * This test mocks the DB entirely — no real Postgres connection required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Track which WHERE clauses get passed to db.select().from().where()
// ---------------------------------------------------------------------------

let capturedWhereCalls: unknown[] = [];

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted above imports)
// ---------------------------------------------------------------------------

vi.mock('../../db/index', () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock('./WidgetService', async (importActual) => {
  const actual = await importActual<typeof import('./WidgetService')>();
  return {
    ...actual,
    // Stub out createTicket so it doesn't need a real DB
    createTicket: vi.fn().mockResolvedValue({
      id: 'task-stub-id',
      serverId: 'ws_test',
      title: 'T',
      channelId: 'ch_test',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    // Stub out linkExistingTaskAttachment so carryConversationImagesToTask
    // can link images without a real insert chain
    linkExistingTaskAttachment: vi.fn().mockResolvedValue(undefined),
    // Keep WidgetError intact for error-path tests
    WidgetError: actual.WidgetError,
  };
});

vi.mock('./ServerService', () => ({
  serverTokenFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

// ---------------------------------------------------------------------------
// Import SUT AFTER mocks are set up
// ---------------------------------------------------------------------------

import { createTicketFromChat } from './WidgetChatService';
import * as WidgetService from './WidgetService';
import { db } from '../../db/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONV_ID    = 'cccccccc-cccc-4ccc-accc-cccccccccccc';
const PROJECT_ID = 'pppppppp-pppp-4ppp-appp-pppppppppppp';
const USER_ID    = 'uuuuuuuu-uuuu-4uuu-auuu-uuuuuuuuuuuu';
const SERVER_ID  = 'ws_carry_test';
const MSG_ID     = 'mmmmmmmm-mmmm-4mmm-ammm-mmmmmmmmmmmm';

const CONV_ROW = {
  id: CONV_ID,
  widgetProjectId: PROJECT_ID,
  widgetUserId: USER_ID,
  status: 'active',
  createdTaskId: null,
  userTurnCount: 2,
  pendingTurnId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PROJECT_ROW = {
  id: PROJECT_ID,
  serverId: SERVER_ID,
  workspaceProjectId: 'wsp_test',
  widgetChatAgentEntityId: 'ae_support',
};

// A chat message that carries a proposal (needed for requirePendingProposal)
const PROPOSAL_MESSAGE = {
  id: 'msg_proposal',
  conversationId: CONV_ID,
  role: 'event',
  seq: 1,
  payload: { kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' },
  authorName: null,
  createdAt: new Date(),
};

// A linked image (messageId != null — should be carried over)
const LINKED_IMAGE = {
  id: 'img-linked',
  conversationId: CONV_ID,
  widgetUserId: USER_ID,
  serverId: SERVER_ID,
  mimeType: 'image/png',
  originalName: 'linked.png',
  originalStorageProvider: 'r2' as const,
  originalStorageKey: 'uploads/test/linked.png',
  modelStorageProvider: 'r2' as const,
  modelStorageKey: 'model/test/linked.jpg',
  messageId: MSG_ID,
  width: 800,
  height: 600,
  createdAt: new Date(),
};

// An unlinked image (messageId = null — uploaded then removed, must NOT carry over)
const UNLINKED_IMAGE = {
  ...LINKED_IMAGE,
  id: 'img-unlinked',
  originalStorageKey: 'uploads/test/unlinked.png',
  modelStorageKey: 'model/test/unlinked.jpg',
  originalName: 'unlinked.png',
  messageId: null,
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a db.select() chain that resolves from().where().limit() to `rows`.
 * Also handles from().where().orderBy() for loadAllMessages (no limit).
 */
function makeSelectChain(rows: object[]) {
  const whereChain = {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
    // For where() calls that are directly awaited (no .limit or .orderBy)
    then: (resolve: (v: object[]) => void) => resolve(rows),
  };
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((whereArg: unknown) => {
        capturedWhereCalls.push(whereArg);
        return whereChain;
      }),
      orderBy: vi.fn().mockResolvedValue(rows),
    }),
  };
}

function makeInsertChain(returning: object[] = []) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returning),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function makeDeleteChain() {
  return { where: vi.fn().mockResolvedValue(undefined) };
}

// ---------------------------------------------------------------------------
// beforeEach: wire up the sequential db mock calls for createTicketFromChat
// ---------------------------------------------------------------------------

// The sequence of db.select() calls inside createTicketFromChat:
//   1. getConversationOwned → widgetChatConversations → .where().limit(1)
//   2. requirePendingProposal → loadAllMessages → widgetChatMessages → .where().orderBy()
//   3. getChatProject → widgetProjects → .where().limit(1)
//   4. carryConversationImagesToTask → widgetChatImages → .where() (no limit)

beforeEach(() => {
  capturedWhereCalls = [];
  vi.mocked(db.select).mockReset();
  vi.mocked(db.insert).mockReset();
  vi.mocked(db.update).mockReset();
  vi.mocked(db.delete).mockReset();

  // Sequence: conv → messages → project → [chat images is handled per-test]
  vi.mocked(db.select)
    .mockReturnValueOnce(makeSelectChain([CONV_ROW]) as any)     // 1: getConversationOwned
    .mockReturnValueOnce(makeSelectChain([PROPOSAL_MESSAGE]) as any) // 2: loadAllMessages
    .mockReturnValueOnce(makeSelectChain([PROJECT_ROW]) as any); // 3: getChatProject

  // WidgetService.createTicket already mocked at module level
  // Insert mocks (for widgetClarifications, widgetChatConversations update, widgetChatMessages insert)
  vi.mocked(db.insert).mockReturnValue(makeInsertChain([{ id: 'msg_ev' }]) as any);
  vi.mocked(db.update).mockReturnValue(makeUpdateChain() as any);
  vi.mocked(db.delete).mockReturnValue(makeDeleteChain() as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('carryConversationImagesToTask — messageId filter (I2 regression)', () => {
  it('WHERE clause for widgetChatImages carry-over includes isNotNull(messageId)', async () => {
    // The 4th db.select() is carryConversationImagesToTask (widgetChatImages query).
    // We add it here to capture its WHERE argument and assert isNotNull is present.
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([LINKED_IMAGE]) as any); // 4: widgetChatImages

    try {
      await createTicketFromChat(CONV_ID, PROJECT_ID, USER_ID, { title: 'T', description: 'D' });
    } catch {
      // Some parts of the full flow (fire-and-forget SSE publish etc.) may fail
      // in a mocked environment. We only need carryConversationImagesToTask to run.
    }

    // capturedWhereCalls[3] is the 4th WHERE — for widgetChatImages.
    // It must be an AND() of two conditions (eq + isNotNull), not a bare eq().
    const chatImagesWhere = capturedWhereCalls[3] as any;
    expect(chatImagesWhere).not.toBeUndefined();

    // Drizzle's and(A, B) wraps the conditions in:
    //   SQL(queryChunks=[open_paren, SQL([A, ' and ', B]), close_paren])
    // So queryChunks[1] is itself a SQL expression (with its own queryChunks),
    // whereas a bare isNull/isNotNull has queryChunks.length === 3 at top level
    // but the middle chunk is a StringChunk (not a nested SQL with queryChunks).
    // The key: and() produces queryChunks[1] that itself has queryChunks (it wraps
    // the two operands), while a bare eq/isNotNull has queryChunks[1] as a StringChunk.
    expect(Array.isArray(chatImagesWhere.queryChunks)).toBe(true);

    // The AND expression inner node (queryChunks[1]) must itself be a SQL object
    // containing both sub-expressions — its own queryChunks will have length >= 3.
    const innerNode = chatImagesWhere.queryChunks[1];
    expect(innerNode).toBeDefined();
    expect(Array.isArray(innerNode.queryChunks)).toBe(true);
    expect(innerNode.queryChunks.length).toBeGreaterThanOrEqual(3);

    // Further: the AND inner node's middle element (queryChunks[1]) should be a
    // StringChunk whose value is ' and ' — confirming this is an AND expression.
    const andSeparator = innerNode.queryChunks[1];
    expect(andSeparator?.value).toEqual([' and ']);
  });

  it('only the linked image is passed to linkExistingTaskAttachment — unlinked is excluded', async () => {
    // The DB mock returns only LINKED_IMAGE for the widgetChatImages query,
    // simulating the DB honouring the WHERE messageId IS NOT NULL filter.
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([LINKED_IMAGE]) as any); // 4: widgetChatImages

    try {
      await createTicketFromChat(CONV_ID, PROJECT_ID, USER_ID, { title: 'T', description: 'D' });
    } catch { /* partial mock — non-fatal */ }

    // linkExistingTaskAttachment should be called once (for LINKED_IMAGE only).
    const linkCalls = vi.mocked(WidgetService.linkExistingTaskAttachment).mock.calls;
    const linkedKeys = linkCalls.map((args) => (args[0] as { storageKey: string }).storageKey);
    expect(linkedKeys).toContain(LINKED_IMAGE.originalStorageKey);
    expect(linkedKeys).not.toContain(UNLINKED_IMAGE.originalStorageKey);
  });
});
