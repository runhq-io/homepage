import { describe, it, expect } from 'vitest';
import {
  parseTaskShareId,
  selectResolvedTask,
  type TaskCandidate,
  type TaskShareIdQuery,
} from './WorkspaceTaskService';

const FULL = '05806cc6-e75f-40a6-a3e2-baf0dbac2fb9';

function candidate(over: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    serverId: 'ws_a',
    channelId: 'chan_a',
    taskId: FULL,
    title: 'Fix the thing',
    legacyWorkspaceTodoId: null,
    createdAt: 1000,
    ...over,
  };
}

describe('parseTaskShareId', () => {
  it('classifies a full UUID as an exact query', () => {
    expect(parseTaskShareId(FULL)).toEqual({ kind: 'exact', value: FULL });
  });

  it('classifies an 8-char hex prefix as a prefix query', () => {
    expect(parseTaskShareId('05806cc6')).toEqual({ kind: 'prefix', value: '05806cc6' });
  });

  it('lowercases and trims before classifying', () => {
    expect(parseTaskShareId('  05806CC6  ')).toEqual({ kind: 'prefix', value: '05806cc6' });
  });

  it('accepts a 4-char minimum prefix', () => {
    expect(parseTaskShareId('0580')).toEqual({ kind: 'prefix', value: '0580' });
  });

  it('rejects non-hex / too-short / garbage input', () => {
    expect(parseTaskShareId('xyz')).toBeNull();
    expect(parseTaskShareId('05g')).toBeNull();
    expect(parseTaskShareId('')).toBeNull();
    expect(parseTaskShareId('../../etc/passwd')).toBeNull();
  });
});

describe('selectResolvedTask', () => {
  const prefixQuery: TaskShareIdQuery = { kind: 'prefix', value: '05806cc6' };
  const exactQuery: TaskShareIdQuery = { kind: 'exact', value: FULL };

  it('returns null when no candidate is on a reachable server', () => {
    const out = selectResolvedTask([candidate({ serverId: 'ws_other' })], new Set(['ws_a']), prefixQuery);
    expect(out).toEqual({ resolved: null, ambiguous: false });
  });

  it('returns null when there are no candidates at all', () => {
    expect(selectResolvedTask([], new Set(['ws_a']), prefixQuery)).toEqual({ resolved: null, ambiguous: false });
  });

  it('resolves a single reachable candidate to its routing tuple', () => {
    const out = selectResolvedTask([candidate()], new Set(['ws_a']), prefixQuery);
    expect(out).toEqual({
      resolved: { serverId: 'ws_a', channelId: 'chan_a', taskId: FULL, title: 'Fix the thing' },
      ambiguous: false,
    });
  });

  it('filters out candidates on servers the user cannot reach before selecting', () => {
    const reachable = candidate({ serverId: 'ws_a', taskId: FULL });
    const hidden = candidate({ serverId: 'ws_secret', taskId: '05806cc6-0000-4000-8000-000000000000' });
    const out = selectResolvedTask([hidden, reachable], new Set(['ws_a']), prefixQuery);
    expect(out.ambiguous).toBe(false);
    expect(out.resolved?.serverId).toBe('ws_a');
    expect(out.resolved?.taskId).toBe(FULL);
  });

  it('on a prefix collision among reachable tasks, picks deterministically (oldest) and flags ambiguous', () => {
    const older = candidate({ taskId: 'aaaa1111-e75f-40a6-a3e2-baf0dbac2fb9', createdAt: 100 });
    const newer = candidate({ taskId: 'bbbb2222-e75f-40a6-a3e2-baf0dbac2fb9', createdAt: 200 });
    const out = selectResolvedTask([newer, older], new Set(['ws_a']), prefixQuery);
    expect(out.ambiguous).toBe(true);
    expect(out.resolved?.taskId).toBe('aaaa1111-e75f-40a6-a3e2-baf0dbac2fb9');
  });

  it('prefers an exact id match over the oldest tiebreak when the input was a full id', () => {
    const decoy = candidate({ taskId: 'aaaa1111-e75f-40a6-a3e2-baf0dbac2fb9', createdAt: 100 });
    const exact = candidate({ taskId: FULL, createdAt: 999 });
    const out = selectResolvedTask([decoy, exact], new Set(['ws_a']), exactQuery);
    expect(out.ambiguous).toBe(true);
    expect(out.resolved?.taskId).toBe(FULL);
  });

  it('matches an exact query against the legacy workspace todo id too', () => {
    const legacy = candidate({ taskId: 'cccc3333-e75f-40a6-a3e2-baf0dbac2fb9', legacyWorkspaceTodoId: FULL, createdAt: 50 });
    const decoy = candidate({ taskId: 'dddd4444-e75f-40a6-a3e2-baf0dbac2fb9', createdAt: 10 });
    const out = selectResolvedTask([decoy, legacy], new Set(['ws_a']), exactQuery);
    expect(out.resolved?.taskId).toBe('cccc3333-e75f-40a6-a3e2-baf0dbac2fb9');
  });
});
