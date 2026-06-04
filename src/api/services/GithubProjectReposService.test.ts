import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { githubProjectRepos, serverMembers } from '../../db/schema';

const calls: any[] = [];
let selectRows: any[] = [];

vi.mock('../../db/index', () => {
  const selectBuilder = (cols?: any) => {
    const b: any = { cols, joins: [] as any[] };
    b.from = (t: any) => { b.from_ = t; return b; };
    b.innerJoin = (t: any, on: any) => { b.joins.push({ t, on }); return b; };
    b.where = (w: any) => { calls.push({ op: 'select', cols, from: b.from_, joins: b.joins, where: w }); return Promise.resolve(selectRows); };
    return b;
  };
  return {
    db: {
      insert: (t: any) => ({
        values: (v: any) => ({
          onConflictDoUpdate: async (c: any) => { calls.push({ op: 'upsert', t, v, c }); },
        }),
      }),
      delete: (t: any) => ({ where: async (w: any) => { calls.push({ op: 'delete', t, w }); } }),
      select: (cols?: any) => selectBuilder(cols),
    },
  };
});

import { upsertProjectRepo, removeProjectRepo, listForUser } from './GithubProjectReposService.js';

describe('GithubProjectReposService', () => {
  beforeEach(() => { calls.length = 0; selectRows = []; });

  it('upserts keyed by (serverId, projectId)', async () => {
    await upsertProjectRepo({ serverId: 's1', projectId: 'p1', installationId: 9, owner: 'acme', repo: 'web', projectName: 'Web' });
    expect(calls[0].op).toBe('upsert');
    expect(calls[0].t).toBe(githubProjectRepos);
    expect(calls[0].v.serverId).toBe('s1');
    expect(calls[0].v.projectId).toBe('p1');
    expect(calls[0].v.installationId).toBe(9);
    expect(calls[0].c.target).toEqual([githubProjectRepos.serverId, githubProjectRepos.projectId]);
  });

  it('removes a link', async () => {
    await removeProjectRepo('s1', 'p1');
    expect(calls[0].op).toBe('delete');
    expect(calls[0].t).toBe(githubProjectRepos);
  });

  it('listForUser joins server_members and returns rows', async () => {
    selectRows = [{ serverId: 's1', projectId: 'p1', installationId: 9, owner: 'acme', repo: 'web', projectName: 'Web' }];
    const rows = await listForUser('u1');
    expect(rows).toHaveLength(1);
    expect(calls[0].from).toBe(serverMembers);
    expect(calls[0].joins[0].t).toBe(githubProjectRepos);
  });
});
