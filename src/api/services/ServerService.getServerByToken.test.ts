import { describe, it, expect, vi } from 'vitest';

let returnedRows: any[] = [];
vi.mock('../../db/index', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => returnedRows) })),
      })),
    })),
  },
}));

import { getServerByToken } from './ServerService';

describe('getServerByToken', () => {
  it('returns the server row when the token hash matches', async () => {
    returnedRows = [{ id: 'ws_a', name: 'A' }];
    const server = await getServerByToken('wst_anything');
    expect(server?.id).toBe('ws_a');
  });
  it('returns null when no row matches', async () => {
    returnedRows = [];
    const server = await getServerByToken('wst_nope');
    expect(server).toBeNull();
  });
});
