import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerInternalGithubRoutes, type InternalGithubDeps } from './internalGithubRoutes.js';

function makeApp(overrides: Partial<InternalGithubDeps> = {}) {
  const deps: InternalGithubDeps = {
    stateSecret: 'st',
    appSlug: 'runhq',
    getServerByToken: async (t) => (t === 'wst_good' ? ({ id: 'ws_a' } as any) : null),
    listInstallationsForServer: async (sid) => (sid === 'ws_a' ? [{ installationId: 5, accountLogin: 'octo', accountType: 'Organization', repositorySelection: 'all' } as any] : []),
    getInstallation: async (id) => (id === 5 ? ({ installationId: 5, serverId: 'ws_a' } as any) : null),
    listInstallationRepos: async () => [{ name: 'app', full_name: 'octo/app', owner: 'octo', clone_url: 'https://github.com/octo/app.git', default_branch: 'main', private: true }],
    listPullRequests: vi.fn(async () => []),
    getPullRequestDiff: vi.fn(async () => ({ sha: '', files: [], patch: '' })),
    mergePullRequest: vi.fn(async () => ({ merged: false, message: '' })),
    ...overrides,
  };
  const app = new Hono();
  registerInternalGithubRoutes(app, deps);
  return { app, deps };
}

const auth = { 'X-Server-Token': 'wst_good' };

describe('internal github routes', () => {
  it('install-url returns a signed install URL', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/install-url', { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain('github.com/apps/runhq/installations/new');
  });

  it('lists installations for the server', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/installations', { headers: auth });
    const body = await res.json();
    expect(body.installations[0].installationId).toBe(5);
  });

  it('lists repos for an installation owned by the server', async () => {
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

  it('rejects repos for an installation owned by another server', async () => {
    const { app } = makeApp({ getInstallation: async () => ({ installationId: 5, serverId: 'ws_OTHER' } as any) });
    const res = await app.request('/api/internal/servers/ws_a/github/installations/5/repos', { headers: auth });
    expect(res.status).toBe(403);
  });
});
