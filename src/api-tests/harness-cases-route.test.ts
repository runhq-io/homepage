/**
 * Integration tests for /api/harness-cases CRUD.
 * Bearer-auth gated; writes additionally gated by users.is_admin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/api/auth/jwt', () => ({
  extractUserIdFromToken: vi.fn(),
}));
vi.mock('@/lib/adminPolicy', () => ({
  isAdmin: vi.fn(),
}));
vi.mock('@/db', () => ({
  getDb: vi.fn(),
  users: { id: 'id', email: 'email' },
  harnessCases: {
    id: 'id',
    label: 'label',
    prompt: 'prompt',
    expectedOutcome: 'expected_outcome',
    createdBy: 'created_by',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}));

import { extractUserIdFromToken } from '@/api/auth/jwt';
import { isAdmin } from '@/lib/adminPolicy';
import { getDb } from '@/db';
import { GET, POST } from '@/app/api/harness-cases/route';
import { PUT, DELETE } from '@/app/api/harness-cases/[id]/route';

const USER_ROW = { id: 'u1', email: 'u@runhq.io' };

function withBearer(body?: any, method: string = 'GET'): Request {
  return new Request('https://console.runhq.io/api/harness-cases', {
    method,
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function mockDb(builders: Record<string, any>) {
  vi.mocked(getDb).mockReturnValue(builders as any);
}

function makeListBuilder(rows: any[]) {
  // db.select().from(harnessCases).orderBy(...)
  return {
    select: () => ({
      from: () => ({
        orderBy: () => Promise.resolve(rows),
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  };
}

function makeInsertBuilder(row: any) {
  return {
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([row]) }),
    }),
  };
}

function makeUpdateBuilder(rows: any[]) {
  return {
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }),
    }),
  };
}

function makeDeleteBuilder(rows: any[]) {
  return {
    delete: () => ({
      where: () => ({ returning: () => Promise.resolve(rows) }),
    }),
  };
}

function makeUserLookup() {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([USER_ROW]),
      }),
    }),
  };
}

function mergeBuilders(...builders: Array<Record<string, any>>) {
  let i = 0;
  const handler = {
    get(_: any, prop: string) {
      const b = builders[i++] ?? builders[builders.length - 1];
      return (b as any)[prop];
    },
  };
  return new Proxy({}, handler) as any;
}

describe('GET /api/harness-cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without a Bearer token', async () => {
    const res = await GET(new Request('https://x/api/harness-cases'));
    expect(res.status).toBe(401);
  });

  it('returns 401 on invalid token', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue(null);
    const res = await GET(withBearer());
    expect(res.status).toBe(401);
  });

  it('returns the case list for any authenticated user', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(false);
    const row = {
      id: 'c1',
      label: 'L',
      prompt: 'P',
      expectedOutcome: 'E',
      createdBy: null,
      createdAt: new Date('2026-05-20T00:00:00Z'),
      updatedAt: new Date('2026-05-20T00:00:00Z'),
    };
    // First select is the user lookup in resolveCaller, second is the list query.
    mockDb(mergeBuilders(makeUserLookup(), makeListBuilder([row])));
    const res = await GET(withBearer());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      {
        id: 'c1',
        label: 'L',
        prompt: 'P',
        expectedOutcome: 'E',
        createdBy: null,
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
    ]);
  });
});

describe('POST /api/harness-cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 for non-admin authenticated user', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(false);
    mockDb(makeUserLookup());
    const res = await POST(withBearer({ label: 'L', prompt: 'P', expectedOutcome: 'E' }, 'POST'));
    expect(res.status).toBe(403);
  });

  it('returns 400 on missing fields', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(true);
    mockDb(makeUserLookup());
    const res = await POST(withBearer({ label: '', prompt: 'P', expectedOutcome: 'E' }, 'POST'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/label/);
  });

  it('creates a case for an admin', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(true);
    const inserted = {
      id: 'gen',
      label: 'L',
      prompt: 'P',
      expectedOutcome: 'E',
      createdBy: 'u1',
      createdAt: new Date('2026-05-20T00:00:00Z'),
      updatedAt: new Date('2026-05-20T00:00:00Z'),
    };
    mockDb(mergeBuilders(makeUserLookup(), makeInsertBuilder(inserted)));
    const res = await POST(withBearer({ label: 'L', prompt: 'P', expectedOutcome: 'E' }, 'POST'));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe('gen');
    expect(body.data.createdBy).toBe('u1');
  });
});

describe('PUT /api/harness-cases/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when no row matches', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(true);
    mockDb(mergeBuilders(makeUserLookup(), makeUpdateBuilder([])));
    const res = await PUT(
      withBearer({ label: 'L', prompt: 'P', expectedOutcome: 'E' }, 'PUT'),
      { params: Promise.resolve({ id: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for non-admin', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(false);
    mockDb(makeUserLookup());
    const res = await PUT(
      withBearer({ label: 'L', prompt: 'P', expectedOutcome: 'E' }, 'PUT'),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(res.status).toBe(403);
  });

  it('updates an existing row for an admin', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(true);
    const updated = {
      id: 'x',
      label: 'L2',
      prompt: 'P2',
      expectedOutcome: 'E2',
      createdBy: 'u1',
      createdAt: new Date('2026-05-20T00:00:00Z'),
      updatedAt: new Date('2026-05-20T00:00:01Z'),
    };
    mockDb(mergeBuilders(makeUserLookup(), makeUpdateBuilder([updated])));
    const res = await PUT(
      withBearer({ label: 'L2', prompt: 'P2', expectedOutcome: 'E2' }, 'PUT'),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.label).toBe('L2');
  });
});

describe('DELETE /api/harness-cases/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when no row matches', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(true);
    mockDb(mergeBuilders(makeUserLookup(), makeDeleteBuilder([])));
    const res = await DELETE(
      withBearer(undefined, 'DELETE'),
      { params: Promise.resolve({ id: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });

  it('hard-deletes an existing row for an admin', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('u1');
    vi.mocked(isAdmin).mockResolvedValue(true);
    mockDb(mergeBuilders(makeUserLookup(), makeDeleteBuilder([{ id: 'x' }])));
    const res = await DELETE(
      withBearer(undefined, 'DELETE'),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
