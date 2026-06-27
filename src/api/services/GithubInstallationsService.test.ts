import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubAppInstallations, githubInstallationWorkspaces } from '../../db/schema';

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
          onConflictDoNothing: async () => { calls.push({ op: 'insertIgnore', t, v }); },
        }),
      }),
      delete: (t: any) => ({ where: async (w: any) => { calls.push({ op: 'delete', t, w }); } }),
      select: (cols?: any) => selectBuilder(cols),
    },
  };
});

import {
  upsertInstallation, removeInstallation, getInstallation,
  associateWithWorkspace, isAssociatedWithWorkspace,
  listInstallationsForServer, listInstallationsForUser,
} from './GithubInstallationsService.js';

describe('GithubInstallationsService', () => {
  beforeEach(() => { calls.length = 0; selectRows = []; });

  it('upsert writes the installation keyed by connectedByUserId (not serverId)', async () => {
    await upsertInstallation({
      installationId: 42, connectedByUserId: 'user_1', accountLogin: 'octo', accountType: 'Organization', repositorySelection: 'all',
    });
    expect(calls[0].op).toBe('upsert');
    expect(calls[0].t).toBe(githubAppInstallations);
    expect(calls[0].v.installationId).toBe(42);
    expect(calls[0].v.connectedByUserId).toBe('user_1');
    expect('serverId' in calls[0].v).toBe(false);
  });

  it('upsert does NOT overwrite the original connector on conflict', async () => {
    await upsertInstallation({
      installationId: 42, connectedByUserId: 'user_2', accountLogin: 'octo', accountType: 'User', repositorySelection: 'all',
    });
    // The connector is recorded once at first connect; re-installs preserve it.
    expect('connectedByUserId' in calls[0].c.set).toBe(false);
  });

  it('remove issues a delete', async () => {
    await removeInstallation(42);
    expect(calls.some((c) => c.op === 'delete' && c.t === githubAppInstallations)).toBe(true);
  });

  it('getInstallation returns the first row', async () => {
    selectRows = [{ installationId: 1, connectedByUserId: 'user_1' }];
    const row = await getInstallation(1);
    expect(row?.installationId).toBe(1);
  });

  it('associateWithWorkspace inserts a join row idempotently', async () => {
    await associateWithWorkspace(5, 'ws_a', 'user_1');
    expect(calls[0].op).toBe('insertIgnore');
    expect(calls[0].t).toBe(githubInstallationWorkspaces);
    expect(calls[0].v).toMatchObject({ installationId: 5, serverId: 'ws_a', addedByUserId: 'user_1' });
  });

  it('isAssociatedWithWorkspace returns true when a join row exists', async () => {
    selectRows = [{ installationId: 5, serverId: 'ws_a' }];
    expect(await isAssociatedWithWorkspace(5, 'ws_a')).toBe(true);
    expect(calls[0].from).toBe(githubInstallationWorkspaces);
  });

  it('isAssociatedWithWorkspace returns false when no join row exists', async () => {
    selectRows = [];
    expect(await isAssociatedWithWorkspace(5, 'ws_b')).toBe(false);
  });

  it('listInstallationsForServer joins the workspace table', async () => {
    selectRows = [{ installationId: 5, accountLogin: 'octo' }];
    const rows = await listInstallationsForServer('ws_a');
    expect(rows[0].installationId).toBe(5);
    expect(calls[0].from).toBe(githubInstallationWorkspaces);
    expect(calls[0].joins[0].t).toBe(githubAppInstallations);
  });

  it('listInstallationsForUser queries installations by connector', async () => {
    selectRows = [{ installationId: 7, connectedByUserId: 'user_1', accountLogin: 'me' }];
    const rows = await listInstallationsForUser('user_1');
    expect(rows[0].installationId).toBe(7);
    expect(calls[0].from).toBe(githubAppInstallations);
  });
});
