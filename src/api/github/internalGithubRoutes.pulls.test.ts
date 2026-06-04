import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerInternalGithubRoutes, type InternalGithubDeps } from './internalGithubRoutes.js';

function makeApp(over: Partial<InternalGithubDeps> = {}) {
  const deps: InternalGithubDeps = {
    stateSecret: 'st', appSlug: 'runhq',
    getServerByToken: async (t) => (t === 'wst_good' ? ({ id: 'ws_a' } as any) : null),
    listInstallationsForServer: async () => [],
    listInstallationsForUser: async () => [],
    getInstallation: async (id) => (id === 5 ? ({ installationId: 5, connectedByUserId: 'user_1' } as any) : null),
    isAssociatedWithWorkspace: async (id, sid) => sid === 'ws_a' && id === 5,
    associateWithWorkspace: vi.fn(async () => {}),
    listInstallationRepos: async () => [],
    listPullRequests: vi.fn(async () => [{ number: 7, title: 'PR' }]),
    getPullRequestDiff: vi.fn(async () => ({ sha: '7', files: [], patch: '' })),
    mergePullRequest: vi.fn(async () => ({ merged: true, message: 'ok' })),
    upsertProjectRepo: vi.fn(async () => {}),
    removeProjectRepo: vi.fn(async () => {}),
    ...over,
  };
  const app = new Hono();
  registerInternalGithubRoutes(app, deps);
  return { app, deps };
}
const auth = { 'X-Server-Token': 'wst_good' };

describe('internal github PR routes', () => {
  it('lists PRs for an owned installation', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/pulls?owner=octo&repo=app&state=open', { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).pulls[0].number).toBe(7);
  });
  it('returns a PR diff', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/pulls/7/diff?owner=octo&repo=app', { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).diff.sha).toBe('7');
  });
  it('merges a PR', async () => {
    const { app, deps } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/pulls/7/merge', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'octo', repo: 'app', method: 'squash' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).merged).toBe(true);
    expect(deps.mergePullRequest).toHaveBeenCalledWith(5, 'octo', 'app', 7, 'squash');
  });
  it('rejects an installation not associated with the workspace', async () => {
    const { app } = makeApp({ isAssociatedWithWorkspace: async () => false });
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/pulls?owner=octo&repo=app', { headers: auth });
    expect(res.status).toBe(403);
  });
});
