import type { Hono } from 'hono';
import { signInstallState } from './installState.js';

export interface InternalGithubDeps {
  stateSecret: string;
  appSlug: string;
  getServerByToken: (token: string) => Promise<{ id: string } | null>;
  /** Installations associated with (available in) the workspace. */
  listInstallationsForServer: (serverId: string) => Promise<Array<{
    installationId: number; accountLogin: string; accountType: string; repositorySelection: string | null;
  }>>;
  /** Installations the given user connected (across all their workspaces). */
  listInstallationsForUser: (userId: string) => Promise<Array<{
    installationId: number; accountLogin: string; accountType: string; repositorySelection: string | null;
  }>>;
  getInstallation: (installationId: number) => Promise<{ installationId: number; connectedByUserId: string | null } | null>;
  isAssociatedWithWorkspace: (installationId: number, serverId: string) => Promise<boolean>;
  associateWithWorkspace: (installationId: number, serverId: string, addedByUserId: string | null) => Promise<void>;
  listInstallationRepos: (installationId: number) => Promise<Array<{
    name: string; full_name: string; owner: string; clone_url: string; default_branch: string; private: boolean;
  }>>;
  listPullRequests: (installationId: number, owner: string, repo: string, state: 'open' | 'closed' | 'all') => Promise<unknown[]>;
  getPullRequestDiff: (installationId: number, owner: string, repo: string, number: number) => Promise<unknown>;
  mergePullRequest: (installationId: number, owner: string, repo: string, number: number, method: 'merge' | 'squash' | 'rebase') => Promise<{ merged: boolean; message: string }>;
  /** Mirror a project -> repo link up from the server machine (for cross-server PR aggregation). */
  upsertProjectRepo: (input: {
    serverId: string; projectId: string; installationId: number; owner: string; repo: string; projectName?: string | null;
  }) => Promise<void>;
  removeProjectRepo: (serverId: string, projectId: string) => Promise<void>;
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
    const body = await c.req.json().catch(() => ({}));
    const userId = typeof body.userId === 'string' ? body.userId : null;
    const state = signInstallState(server.id, userId, deps.stateSecret);
    return c.json({ url: `https://github.com/apps/${deps.appSlug}/installations/new?state=${encodeURIComponent(state)}` });
  });

  app.get('/api/internal/servers/:serverId/github/installations', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    return c.json({ installations: await deps.listInstallationsForServer(server.id) });
  });

  // Accounts the current user has connected but that are NOT yet available in
  // this workspace — lets a second workspace self-serve without a GitHub round-trip.
  app.get('/api/internal/servers/:serverId/github/user-installations', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const userId = c.req.query('userId');
    if (!userId) return c.json({ error: 'userId required' }, 400);
    const [connected, associated] = await Promise.all([
      deps.listInstallationsForUser(userId),
      deps.listInstallationsForServer(server.id),
    ]);
    const associatedIds = new Set(associated.map((i) => i.installationId));
    return c.json({ installations: connected.filter((i) => !associatedIds.has(i.installationId)) });
  });

  // Make a user-connected installation available in this workspace. Idempotent;
  // requires the actor to have connected it on GitHub (proof of control).
  app.post('/api/internal/servers/:serverId/github/installations/:installationId/associate', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = Number(c.req.param('installationId'));
    const body = await c.req.json().catch(() => ({}));
    const userId = typeof body.userId === 'string' ? body.userId : null;
    if (await deps.isAssociatedWithWorkspace(installationId, server.id)) {
      return c.json({ ok: true });
    }
    const install = await deps.getInstallation(installationId);
    if (!install) return c.json({ error: 'Installation not found' }, 404);
    if (!userId || install.connectedByUserId !== userId) return c.json({ error: 'Forbidden' }, 403);
    await deps.associateWithWorkspace(installationId, server.id, userId);
    return c.json({ ok: true });
  });

  // Installation must be available in (associated with) the workspace.
  const associatedInstall = async (c: any, server: { id: string }) => {
    const installationId = Number(c.req.param('installationId'));
    if (!(await deps.isAssociatedWithWorkspace(installationId, server.id))) return null;
    return installationId;
  };

  app.get('/api/internal/servers/:serverId/github/installations/:installationId/repos', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = await associatedInstall(c, server);
    if (installationId === null) return c.json({ error: 'Forbidden' }, 403);
    return c.json({ repos: await deps.listInstallationRepos(installationId) });
  });

  app.get('/api/internal/servers/:serverId/github/installations/:installationId/pulls', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = await associatedInstall(c, server);
    if (installationId === null) return c.json({ error: 'Forbidden' }, 403);
    const owner = c.req.query('owner') ?? '';
    const repo = c.req.query('repo') ?? '';
    const state = (c.req.query('state') as 'open' | 'closed' | 'all') || 'open';
    return c.json({ pulls: await deps.listPullRequests(installationId, owner, repo, state) });
  });

  app.get('/api/internal/servers/:serverId/github/installations/:installationId/pulls/:number/diff', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = await associatedInstall(c, server);
    if (installationId === null) return c.json({ error: 'Forbidden' }, 403);
    const owner = c.req.query('owner') ?? '';
    const repo = c.req.query('repo') ?? '';
    return c.json({ diff: await deps.getPullRequestDiff(installationId, owner, repo, Number(c.req.param('number'))) });
  });

  app.post('/api/internal/servers/:serverId/github/installations/:installationId/pulls/:number/merge', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const installationId = await associatedInstall(c, server);
    if (installationId === null) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const result = await deps.mergePullRequest(installationId, body.owner ?? '', body.repo ?? '', Number(c.req.param('number')), (body.method as any) || 'merge');
    return c.json(result);
  });

  // Sync a project's repo link into the central mirror. The installation must be
  // available in this workspace (proof the server may reference it).
  app.put('/api/internal/servers/:serverId/github/project-repos', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    const body = await c.req.json().catch(() => ({}));
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const installationId = Number(body.installationId);
    const owner = typeof body.owner === 'string' ? body.owner : '';
    const repo = typeof body.repo === 'string' ? body.repo : '';
    if (!projectId || !installationId || !owner || !repo) {
      return c.json({ error: 'projectId, installationId, owner, repo are required' }, 400);
    }
    if (!(await deps.isAssociatedWithWorkspace(installationId, server.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await deps.upsertProjectRepo({
      serverId: server.id,
      projectId,
      installationId,
      owner,
      repo,
      projectName: typeof body.projectName === 'string' ? body.projectName : null,
    });
    return c.json({ ok: true });
  });

  app.delete('/api/internal/servers/:serverId/github/project-repos/:projectId', async (c) => {
    const server = await authServer(c);
    if (server instanceof Response) return server;
    await deps.removeProjectRepo(server.id, c.req.param('projectId'));
    return c.json({ ok: true });
  });
}
