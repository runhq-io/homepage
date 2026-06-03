import type { Hono } from 'hono';
import { signInstallState } from './installState.js';

export interface InternalGithubDeps {
  stateSecret: string;
  appSlug: string;
  getServerByToken: (token: string) => Promise<{ id: string } | null>;
  listInstallationsForServer: (serverId: string) => Promise<Array<{
    installationId: number; accountLogin: string; accountType: string; repositorySelection: string | null;
  }>>;
  getInstallation: (installationId: number) => Promise<{ installationId: number; serverId: string } | null>;
  listInstallationRepos: (installationId: number) => Promise<Array<{
    name: string; full_name: string; owner: string; clone_url: string; default_branch: string; private: boolean;
  }>>;
  listPullRequests: (installationId: number, owner: string, repo: string, state: 'open' | 'closed' | 'all') => Promise<unknown[]>;
  getPullRequestDiff: (installationId: number, owner: string, repo: string, number: number) => Promise<unknown>;
  mergePullRequest: (installationId: number, owner: string, repo: string, number: number, method: 'merge' | 'squash' | 'rebase') => Promise<{ merged: boolean; message: string }>;
}

export function registerInternalGithubRoutes(app: Hono, deps: InternalGithubDeps): void {
  const authServer = async (c: any): Promise<{ id: string } | Response> => {
    const token = c.req.header('X-Server-Token');
    if (!token) return c.json({ error: 'X-Server-Token required' }, 401);
    const server = await deps.getServerByToken(token);
    if (!server || server.id !== c.req.param('serverId')) return c.json({ error: 'Invalid server token' }, 401);
    return server;
  };

  app.post('/api/internal/servers/:serverId/github/install-url', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const state = signInstallState(server.id, deps.stateSecret);
    return c.json({ url: `https://github.com/apps/${deps.appSlug}/installations/new?state=${encodeURIComponent(state)}` });
  });

  app.get('/api/internal/servers/:serverId/github/installations', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    return c.json({ installations: await deps.listInstallationsForServer(server.id) });
  });

  app.get('/api/internal/servers/:serverId/github/installations/:installationId/repos', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = Number(c.req.param('installationId'));
    const install = await deps.getInstallation(installationId);
    if (!install || install.serverId !== server.id) return c.json({ error: 'Forbidden' }, 403);
    return c.json({ repos: await deps.listInstallationRepos(installationId) });
  });

  const ownedInstall = async (c: any, server: { id: string }) => {
    const installationId = Number(c.req.param('installationId'));
    const install = await deps.getInstallation(installationId);
    if (!install || install.serverId !== server.id) return null;
    return installationId;
  };

  app.get('/api/internal/servers/:serverId/github/installations/:installationId/pulls', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = await ownedInstall(c, server);
    if (installationId === null) return c.json({ error: 'Forbidden' }, 403);
    const owner = c.req.query('owner') ?? '';
    const repo = c.req.query('repo') ?? '';
    const state = (c.req.query('state') as 'open' | 'closed' | 'all') || 'open';
    return c.json({ pulls: await deps.listPullRequests(installationId, owner, repo, state) });
  });

  app.get('/api/internal/servers/:serverId/github/installations/:installationId/pulls/:number/diff', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = await ownedInstall(c, server);
    if (installationId === null) return c.json({ error: 'Forbidden' }, 403);
    const owner = c.req.query('owner') ?? '';
    const repo = c.req.query('repo') ?? '';
    return c.json({ diff: await deps.getPullRequestDiff(installationId, owner, repo, Number(c.req.param('number'))) });
  });

  app.post('/api/internal/servers/:serverId/github/installations/:installationId/pulls/:number/merge', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = await ownedInstall(c, server);
    if (installationId === null) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const result = await deps.mergePullRequest(installationId, body.owner ?? '', body.repo ?? '', Number(c.req.param('number')), (body.method as any) || 'merge');
    return c.json(result);
  });
}
