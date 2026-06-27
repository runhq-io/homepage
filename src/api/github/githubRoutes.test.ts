import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { registerGithubRoutes, type GithubRoutesDeps } from './githubRoutes.js';
import { signInstallState } from './installState.js';

const cfg = { appId: '1', appSlug: 'runhq', privateKey: 'k', webhookSecret: 'whsec', stateSecret: 'st' };

function makeApp(overrides: Partial<GithubRoutesDeps> = {}) {
  const deps: GithubRoutesDeps = {
    config: cfg,
    clientUrl: 'https://app.runhq.io',
    getServerByToken: async (t: string) => (t === 'wst_good' ? ({ id: 'ws_a' } as any) : null),
    upsertInstallation: vi.fn(async () => {}),
    removeInstallation: vi.fn(async () => {}),
    getInstallation: async (id: number) => (id === 5 ? ({ installationId: 5, connectedByUserId: 'user_1' } as any) : null),
    associateWithWorkspace: vi.fn(async () => {}),
    isAssociatedWithWorkspace: async (id: number, sid: string) => id === 5 && sid === 'ws_a',
    mintInstallationToken: async (id: number) => ({ token: `tok_${id}`, expiresAt: 'soon' }),
    fetchInstallationAccount: vi.fn(async (_id: number) => ({ accountLogin: 'pranshu6', accountType: 'User' as const, repositorySelection: 'all' as const })),
    ...overrides,
  };
  const app = new Hono();
  registerGithubRoutes(app, deps);
  return { app, deps };
}

describe('github routes', () => {
  it('setup callback records the installation, associates it with the workspace, and redirects', async () => {
    const { app, deps } = makeApp();
    const state = signInstallState('ws_a', 'user_1', cfg.stateSecret);
    const res = await app.request(`/api/github/setup?installation_id=5&setup_action=install&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    // Must redirect to the CLIENT SPA origin (app.runhq.io), not the BE origin —
    // the /github/installed page only exists on the client.
    expect(res.headers.get('location')).toBe('https://app.runhq.io/github/installed');
    // The account identity is read from GitHub synchronously and persisted — not
    // left blank for a webhook to (maybe) backfill later.
    expect(deps.fetchInstallationAccount).toHaveBeenCalledWith(5);
    expect(deps.upsertInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 5, connectedByUserId: 'user_1', accountLogin: 'pranshu6', accountType: 'User', repositorySelection: 'all' }),
    );
    expect(deps.associateWithWorkspace).toHaveBeenCalledWith(5, 'ws_a', 'user_1');
  });

  it('setup callback still records the installation (without a blank-clobbering identity) when the GitHub read fails', async () => {
    const { app, deps } = makeApp({ fetchInstallationAccount: vi.fn(async () => { throw new Error('github down'); }) });
    const state = signInstallState('ws_a', 'user_1', cfg.stateSecret);
    const res = await app.request(`/api/github/setup?installation_id=5&setup_action=install&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(deps.upsertInstallation).toHaveBeenCalledWith(expect.objectContaining({ installationId: 5, accountLogin: '' }));
    expect(deps.associateWithWorkspace).toHaveBeenCalledWith(5, 'ws_a', 'user_1');
  });

  it('setup callback with an invalid state redirects to an error and does not record', async () => {
    const { app, deps } = makeApp();
    const res = await app.request('/api/github/setup?installation_id=5&state=bogus', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/github/installed?error=1');
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.associateWithWorkspace).not.toHaveBeenCalled();
  });

  it('webhook rejects a bad signature', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'x-github-event': 'installation', 'x-hub-signature-256': 'sha256=bad' },
      body: JSON.stringify({ action: 'created' }),
    });
    expect(res.status).toBe(401);
  });

  it('webhook installation.deleted removes the installation', async () => {
    const { app, deps } = makeApp();
    const payload = JSON.stringify({ action: 'deleted', installation: { id: 5 } });
    const sig = 'sha256=' + createHmac('sha256', cfg.webhookSecret).update(payload).digest('hex');
    const res = await app.request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'x-github-event': 'installation', 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(deps.removeInstallation).toHaveBeenCalledWith(5);
  });

  it('internal token endpoint returns a token for a workspace the installation is associated with', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/token', {
      method: 'POST',
      headers: { 'X-Server-Token': 'wst_good', 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 5 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe('tok_5');
  });

  it('internal token endpoint rejects an installation not associated with the workspace', async () => {
    const { app } = makeApp({ isAssociatedWithWorkspace: async () => false });
    const res = await app.request('/api/internal/servers/ws_a/github/token', {
      method: 'POST',
      headers: { 'X-Server-Token': 'wst_good', 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 5 }),
    });
    expect(res.status).toBe(403);
  });
});
