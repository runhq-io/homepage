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
}
