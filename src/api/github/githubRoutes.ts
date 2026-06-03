import type { Hono } from 'hono';
import { verifyGithubWebhook } from './verifyWebhook.js';
import { signInstallState, verifyInstallState } from './installState.js';
import type { GithubAppConfig } from './config.js';

export interface GithubRoutesDeps {
  config: GithubAppConfig;
  appUrl: string;
  resolveUserId: (authHeader: string | undefined) => Promise<string | null>;
  serverBelongsToUser: (serverId: string, userId: string) => Promise<boolean>;
  getServerByToken: (token: string) => Promise<{ id: string } | null>;
  upsertInstallation: (input: {
    installationId: number; serverId: string; accountLogin: string;
    accountType: 'User' | 'Organization'; repositorySelection?: 'all' | 'selected' | null;
  }) => Promise<void>;
  removeInstallation: (installationId: number) => Promise<void>;
  getInstallation: (installationId: number) => Promise<{ installationId: number; serverId: string } | null>;
  mintInstallationToken: (installationId: number) => Promise<{ token: string; expiresAt: string }>;
}

export function registerGithubRoutes(app: Hono, deps: GithubRoutesDeps): void {
  app.get('/api/github/install-start', async (c) => {
    const userId = await deps.resolveUserId(c.req.header('Authorization'));
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const serverId = c.req.query('serverId');
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    if (!(await deps.serverBelongsToUser(serverId, userId))) return c.json({ error: 'Forbidden' }, 403);
    const state = signInstallState(serverId, deps.config.stateSecret);
    const url = `https://github.com/apps/${deps.config.appSlug}/installations/new?state=${encodeURIComponent(state)}`;
    return c.json({ url });
  });

  app.get('/api/github/setup', async (c) => {
    const installationId = Number(c.req.query('installation_id'));
    const state = c.req.query('state');
    const serverId = state ? verifyInstallState(state, deps.config.stateSecret) : null;
    if (!installationId || !serverId) {
      return c.redirect(`${deps.appUrl}/settings?github=error`, 302);
    }
    await deps.upsertInstallation({
      installationId, serverId, accountLogin: '', accountType: 'User', repositorySelection: null,
    });
    return c.redirect(`${deps.appUrl}/settings?github=installed`, 302);
  });

  app.post('/api/github/webhooks', async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header('x-hub-signature-256');
    if (!verifyGithubWebhook(raw, sig, deps.config.webhookSecret)) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    const event = c.req.header('x-github-event');
    const payload = JSON.parse(raw);

    if (event === 'installation') {
      const id = payload.installation?.id as number;
      if (payload.action === 'deleted') {
        await deps.removeInstallation(id);
      } else if (payload.action === 'created' || payload.action === 'unsuspend' || payload.action === 'new_permissions_accepted') {
        const existing = await deps.getInstallation(id);
        if (existing) {
          await deps.upsertInstallation({
            installationId: id,
            serverId: existing.serverId,
            accountLogin: payload.installation?.account?.login ?? '',
            accountType: payload.installation?.account?.type === 'Organization' ? 'Organization' : 'User',
            repositorySelection: payload.installation?.repository_selection ?? null,
          });
        }
      }
    }
    return c.json({ ok: true });
  });

  app.post('/api/internal/servers/:serverId/github/token', async (c) => {
    const token = c.req.header('X-Server-Token');
    if (!token) return c.json({ error: 'X-Server-Token required' }, 401);
    const server = await deps.getServerByToken(token);
    const serverId = c.req.param('serverId');
    if (!server || server.id !== serverId) return c.json({ error: 'Invalid server token' }, 401);

    const body = await c.req.json().catch(() => ({}));
    const installationId = Number(body.installationId);
    if (!installationId) return c.json({ error: 'installationId required' }, 400);

    const install = await deps.getInstallation(installationId);
    if (!install || install.serverId !== serverId) return c.json({ error: 'Forbidden' }, 403);

    const minted = await deps.mintInstallationToken(installationId);
    return c.json(minted);
  });
}
