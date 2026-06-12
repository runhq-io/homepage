import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerInternalGithubRoutes, type InternalGithubDeps } from './internalGithubRoutes.js';
import { verifyInstallState } from './installState.js';

function makeApp(overrides: Partial<InternalGithubDeps> = {}) {
  // Scenario: installation 5 (org, repositorySelection 'all') and installation 7
  // (org, repositorySelection 'selected') are both associated with ws_a and were
  // connected by user_1. Installation 9 (user, 'selected') is connected by user_1
  // but NOT yet associated with ws_a (an account available to add).
  //
  // user_1 and user_2 are both members of ws_a; user_3 is not a member.
  const installs: Record<number, { connectedByUserId: string | null; repositorySelection: 'all' | 'selected' | null }> = {
    5: { connectedByUserId: 'user_1', repositorySelection: 'all' },
    7: { connectedByUserId: 'user_1', repositorySelection: 'selected' },
    9: { connectedByUserId: 'user_1', repositorySelection: 'selected' },
  };
  const deps: InternalGithubDeps = {
    stateSecret: 'st',
    appSlug: 'runhq',
    getServerByToken: async (t) => (t === 'wst_good' ? ({ id: 'ws_a' } as any) : null),
    // The acting user is derived from the Bearer token — never from a request field.
    authenticateUser: async (bearer) =>
      bearer === 'bear_user1' ? 'user_1' : bearer === 'bear_user2' ? 'user_2' : bearer === 'bear_user3' ? 'user_3' : null,
    canAccessServer: async (sid, uid) => sid === 'ws_a' && (uid === 'user_1' || uid === 'user_2'),
    listInstallationsForServer: async (sid) => (sid === 'ws_a' ? [
      { installationId: 5, accountLogin: 'octo', accountType: 'Organization', repositorySelection: 'all' } as any,
      { installationId: 7, accountLogin: 'octo2', accountType: 'Organization', repositorySelection: 'selected' } as any,
    ] : []),
    listInstallationsForUser: async (uid) => (uid === 'user_1' ? [
      { installationId: 5, accountLogin: 'octo', accountType: 'Organization', repositorySelection: 'all' } as any,
      { installationId: 9, accountLogin: 'pranshu6', accountType: 'User', repositorySelection: 'selected' } as any,
    ] : []),
    getInstallation: async (id) => (installs[id] ? ({ installationId: id, ...installs[id] } as any) : null),
    isAssociatedWithWorkspace: async (id, sid) => sid === 'ws_a' && (id === 5 || id === 7),
    associateWithWorkspace: vi.fn(async () => {}),
    listInstallationRepos: async () => [{ name: 'app', full_name: 'octo/app', owner: 'octo', clone_url: 'https://github.com/octo/app.git', default_branch: 'main', private: true }],
    listPullRequests: vi.fn(async () => []),
    getPullRequestDiff: vi.fn(async () => ({ sha: '', files: [], patch: '' })),
    mergePullRequest: vi.fn(async () => ({ merged: false, message: '' })),
    closePullRequest: vi.fn(async () => ({ closed: false, message: '' })),
    upsertProjectRepo: vi.fn(async () => {}),
    removeProjectRepo: vi.fn(async () => {}),
    ...overrides,
  };
  const app = new Hono();
  registerInternalGithubRoutes(app, deps);
  return { app, deps };
}

const auth = { 'X-Server-Token': 'wst_good' };
// A request carrying both the workspace's server token AND the acting user's Bearer.
const asUser = (bearer: string, json = false) => ({
  'X-Server-Token': 'wst_good',
  Authorization: `Bearer ${bearer}`,
  ...(json ? { 'content-type': 'application/json' } : {}),
});

describe('internal github routes', () => {
  it('install-url returns a signed install URL whose state encodes the Bearer-derived userId', async () => {
    const { app } = makeApp();
    // userId is NOT supplied by the caller — the BE derives it from the Bearer.
    const res = await app.request('/api/internal/servers/ws_a/github/install-url', { method: 'POST', headers: asUser('bear_user1', true), body: JSON.stringify({ userId: 'user_999' }) });
    expect(res.status).toBe(200);
    const url = new URL((await res.json()).url);
    expect(url.href).toContain('github.com/apps/runhq/installations/new');
    const decoded = verifyInstallState(url.searchParams.get('state')!, 'st');
    expect(decoded).toEqual({ serverId: 'ws_a', userId: 'user_1' });
  });

  it('install-url requires an authenticated user Bearer', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/install-url', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'user_1' }) });
    expect(res.status).toBe(401);
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

  // ── Repo browsing: Finding 2 (installation-scoped over-sharing) ──────────────

  it('lets the connector browse repos of an all-repositories installation', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/repos', { headers: asUser('bear_user1') });
    expect(res.status).toBe(200);
    expect((await res.json()).repos[0].full_name).toBe('octo/app');
  });

  it('blocks a non-connector from browsing an all-repositories installation', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/repos', { headers: asUser('bear_user2') });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('all_repos_connector_only');
  });

  it('lets any member browse a selected-repositories installation (curated by the connector on GitHub)', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/7/repos', { headers: asUser('bear_user2') });
    expect(res.status).toBe(200);
    expect((await res.json()).repos[0].full_name).toBe('octo/app');
  });

  it('resolves an unknown repositorySelection via backfill before gating', async () => {
    const backfillInstallationAccount = vi.fn(async () => ({ accountLogin: 'octo', accountType: 'Organization' as const, repositorySelection: 'selected' as string | null }));
    const { app } = makeApp({
      getInstallation: async (id) => (id === 5 ? ({ installationId: 5, connectedByUserId: 'user_1', repositorySelection: null } as any) : null),
      isAssociatedWithWorkspace: async (id, sid) => sid === 'ws_a' && id === 5,
      backfillInstallationAccount,
    });
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/repos', { headers: asUser('bear_user2') });
    expect(backfillInstallationAccount).toHaveBeenCalledWith(5);
    expect(res.status).toBe(200);
  });

  it('requires an authenticated user Bearer to browse repos', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/7/repos', { headers: auth });
    expect(res.status).toBe(401);
  });

  it('rejects a member-less (non-member) user from browsing repos', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/7/repos', { headers: asUser('bear_user3') });
    expect(res.status).toBe(403);
  });

  it('rejects a bad server token', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations', { headers: { 'X-Server-Token': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('rejects repos for an installation not associated with the workspace', async () => {
    const { app } = makeApp({ isAssociatedWithWorkspace: async () => false });
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/repos', { headers: asUser('bear_user1') });
    expect(res.status).toBe(403);
  });

  // ── user-installations + associate: Finding 3 (impersonation) ────────────────

  it('user-installations lists the Bearer-user\'s installs not yet associated with this workspace', async () => {
    const { app } = makeApp();
    // No userId query param — identity comes from the Bearer.
    const res = await app.request('/api/internal/servers/ws_a/github/user-installations', { headers: asUser('bear_user1') });
    const body = await res.json();
    // installation 5 is already associated with ws_a → filtered out; only 9 remains.
    expect(body.installations.map((i: any) => i.installationId)).toEqual([9]);
  });

  it('user-installations cannot be steered to another user via a request field', async () => {
    const { app } = makeApp();
    // user_2 asks (via the old, removed query param) for user_1's accounts — must be ignored.
    const res = await app.request('/api/internal/servers/ws_a/github/user-installations?userId=user_1', { headers: asUser('bear_user2') });
    const body = await res.json();
    // user_2 has no connected installs → empty, regardless of the spoofed query.
    expect(body.installations).toEqual([]);
  });

  it('user-installations requires an authenticated user Bearer', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/user-installations', { headers: auth });
    expect(res.status).toBe(401);
  });

  it('associate links a Bearer-user-connected installation to the workspace', async () => {
    const { app, deps } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/9/associate', { method: 'POST', headers: asUser('bear_user1', true), body: '{}' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(deps.associateWithWorkspace).toHaveBeenCalledWith(9, 'ws_a', 'user_1');
  });

  it('associate is a no-op when the installation is already associated', async () => {
    const { app, deps } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/associate', { method: 'POST', headers: asUser('bear_user1', true), body: '{}' });
    expect(res.status).toBe(200);
    expect(deps.associateWithWorkspace).not.toHaveBeenCalled();
  });

  it('associate rejects an installation the Bearer-user did not connect (no impersonation via a userId field)', async () => {
    const { app, deps } = makeApp();
    // user_2 tries to claim user_1's installation 9, spoofing the old body field.
    const res = await app.request('/api/internal/servers/ws_a/github/installations/9/associate', { method: 'POST', headers: asUser('bear_user2', true), body: JSON.stringify({ userId: 'user_1' }) });
    expect(res.status).toBe(403);
    expect(deps.associateWithWorkspace).not.toHaveBeenCalled();
  });

  it('associate requires an authenticated user Bearer', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/9/associate', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('associate returns 404 for an unknown installation', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/123/associate', { method: 'POST', headers: asUser('bear_user1', true), body: '{}' });
    expect(res.status).toBe(404);
  });
});
