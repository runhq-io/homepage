import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { registerGithubRoutes, type GithubRoutesDeps } from './githubRoutes.js';
import { signInstallState } from './installState.js';

const cfg = { appId: '1', appSlug: 'runhq', privateKey: 'k', webhookSecret: 'whsec', stateSecret: 'st' };

function makeApp(overrides: Partial<GithubRoutesDeps> = {}) {
  const deps: GithubRoutesDeps = {
    config: cfg,
    appUrl: 'https://app.runhq.io',
    resolveUserId: async () => 'user_1',
    serverBelongsToUser: async () => true,
    getServerByToken: async (t: string) => (t === 'wst_good' ? ({ id: 'ws_a' } as any) : null),
    upsertInstallation: vi.fn(async () => {}),
    removeInstallation: vi.fn(async () => {}),
    getInstallation: async (id: number) => (id === 5 ? ({ installationId: 5, serverId: 'ws_a' } as any) : null),
    mintInstallationToken: async (id: number) => ({ token: `tok_${id}`, expiresAt: 'soon' }),
    ...overrides,
  };
  const app = new Hono();
  registerGithubRoutes(app, deps);
  return { app, deps };
}

describe('github routes', () => {
  it('install-start returns a github install URL with signed state', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/github/install-start?serverId=ws_a', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain('https://github.com/apps/runhq/installations/new');
    expect(body.url).toContain('state=');
  });

  it('setup callback records the installation and redirects', async () => {
    const { app, deps } = makeApp();
    const state = signInstallState('ws_a', cfg.stateSecret);
    const res = await app.request(`/api/github/setup?installation_id=5&setup_action=install&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(deps.upsertInstallation).toHaveBeenCalled();
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

  it('internal token endpoint returns a token for a matching server', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/internal/servers/ws_a/github/token', {
      method: 'POST',
      headers: { 'X-Server-Token': 'wst_good', 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 5 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe('tok_5');
  });

  it('internal token endpoint rejects an installation owned by another server', async () => {
    const { app } = makeApp({ getInstallation: async () => ({ installationId: 5, serverId: 'ws_OTHER' } as any) });
    const res = await app.request('/api/internal/servers/ws_a/github/token', {
      method: 'POST',
      headers: { 'X-Server-Token': 'wst_good', 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 5 }),
    });
    expect(res.status).toBe(403);
  });
});
