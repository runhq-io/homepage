import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerInternalGithubRoutes, type InternalGithubDeps } from './internalGithubRoutes.js';
import { verifyInstallState } from './installState.js';

function makeApp(overrides: Partial<InternalGithubDeps> = {}) {
  // Scenario: installation 5 is associated with ws_a (connected by user_1);
  // installation 9 is also connected by user_1 but NOT yet associated with ws_a
  // (an account available to add — the worked-example "second account" case).
  const deps: InternalGithubDeps = {
    stateSecret: 'st',
    appSlug: 'runhq',
    getServerByToken: async (t) => (t === 'wst_good' ? ({ id: 'ws_a' } as any) : null),
    listInstallationsForServer: async (sid) => (sid === 'ws_a' ? [{ installationId: 5, accountLogin: 'octo', accountType: 'Organization', repositorySelection: 'all' } as any] : []),
    listInstallationsForUser: async (uid) => (uid === 'user_1' ? [
      { installationId: 5, accountLogin: 'octo', accountType: 'Organization', repositorySelection: 'all' } as any,
      { installationId: 9, accountLogin: 'pranshu6', accountType: 'User', repositorySelection: 'selected' } as any,
    ] : []),
    getInstallation: async (id) => (id === 5 || id === 9 ? ({ installationId: id, connectedByUserId: 'user_1' } as any) : null),
    isAssociatedWithWorkspace: async (id, sid) => sid === 'ws_a' && id === 5,
    associateWithWorkspace: vi.fn(async () => {}),
    listInstallationRepos: async () => [{ name: 'app', full_name: 'octo/app', owner: 'octo', clone_url: 'https://github.com/octo/app.git', default_branch: 'main', private: true }],
    listPullRequests: vi.fn(async () => []),
    getPullRequestDiff: vi.fn(async () => ({ sha: '', files: [], patch: '' })),
    mergePullRequest: vi.fn(async () => ({ merged: false, message: '' })),
    upsertProjectRepo: vi.fn(async () => {}),
    removeProjectRepo: vi.fn(async () => {}),
    ...overrides,
  };
  const app = new Hono();
  registerInternalGithubRoutes(app, deps);
  return { app, deps };
}

const auth = { 'X-Server-Token': 'wst_good' };
const jsonAuth = { ...auth, 'content-type': 'application/json' };

describe('internal github routes', () => {
  it('install-url returns a signed install URL whose state encodes the acting userId', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/install-url', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'user_1' }) });
    expect(res.status).toBe(200);
    const url = new URL((await res.json()).url);
    expect(url.href).toContain('github.com/apps/runhq/installations/new');
    const decoded = verifyInstallState(url.searchParams.get('state')!, 'st');
    expect(decoded).toEqual({ serverId: 'ws_a', userId: 'user_1' });
  });

  it('lists installations associated with the server', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations', { headers: auth });
    const body = await res.json();
    expect(body.installations[0].installationId).toBe(5);
  });

  it('heals a blank account login on read via backfill, returning the resolved identity', async () => {
    const backfillInstallationAccount = vi.fn(async (id: number) =>
      id === 8 ? { accountLogin: 'pranshu6', accountType: 'User', repositorySelection: 'selected' as string | null } : null);
    const { app } = makeApp({
      listInstallationsForServer: async (sid) => (sid === 'ws_a'
        ? [{ installationId: 8, accountLogin: '', accountType: 'User', repositorySelection: null } as any]
        : []),
      backfillInstallationAccount,
    });
    const res = await app.request('/api/internal/servers/ws_a/github/installations', { headers: auth });
    const body = await res.json();
    expect(backfillInstallationAccount).toHaveBeenCalledWith(8);
    expect(body.installations[0]).toMatchObject({ installationId: 8, accountLogin: 'pranshu6', accountType: 'User' });
  });

  it('does not backfill rows whose login is already known', async () => {
    const backfillInstallationAccount = vi.fn(async () => null);
    const { app } = makeApp({ backfillInstallationAccount });
    const res = await app.request('/api/internal/servers/ws_a/github/installations', { headers: auth });
    expect(res.status).toBe(200);
    expect(backfillInstallationAccount).not.toHaveBeenCalled();
  });

  it('lists repos for an installation associated with the server', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/repos', { headers: auth });
    const body = await res.json();
    expect(body.repos[0].full_name).toBe('octo/app');
  });

  it('rejects a bad server token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations', { headers: { 'X-Server-Token': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('rejects repos for an installation not associated with the workspace', async () => {
    const { app } = makeApp({ isAssociatedWithWorkspace: async () => false });
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/repos', { headers: auth });
    expect(res.status).toBe(403);
  });

  it('user-installations lists the user-connected installs not yet associated with this workspace', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/user-installations?userId=user_1', { headers: auth });
    const body = await res.json();
    // installation 5 is already associated with ws_a → filtered out; only 9 remains.
    expect(body.installations.map((i: any) => i.installationId)).toEqual([9]);
  });

  it('user-installations requires a userId', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/user-installations', { headers: auth });
    expect(res.status).toBe(400);
  });

  it('associate links a user-connected installation to the workspace', async () => {
    const { app, deps } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/9/associate', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'user_1' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(deps.associateWithWorkspace).toHaveBeenCalledWith(9, 'ws_a', 'user_1');
  });

  it('associate is a no-op when the installation is already associated', async () => {
    const { app, deps } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/associate', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'user_1' }) });
    expect(res.status).toBe(200);
    expect(deps.associateWithWorkspace).not.toHaveBeenCalled();
  });

  it('associate rejects an installation the user did not connect', async () => {
    const { app, deps } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/9/associate', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'user_2' }) });
    expect(res.status).toBe(403);
    expect(deps.associateWithWorkspace).not.toHaveBeenCalled();
  });

  it('associate returns 404 for an unknown installation', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/123/associate', { method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'user_1' }) });
    expect(res.status).toBe(404);
  });
});
