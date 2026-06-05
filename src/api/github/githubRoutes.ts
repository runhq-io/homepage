import type { Hono } from 'hono';
import { verifyGithubWebhook } from './verifyWebhook.js';
import { verifyInstallState } from './installState.js';
import type { GithubAppConfig } from './config.js';
import type { ActivityType } from '@runhq/server-protocol';
import type { TaskShareIdQuery, TaskCandidate } from '../services/WorkspaceTaskService.js';

// ---------------------------------------------------------------------------
// PR-linking sub-types (kept narrow so the handler stays unit-testable)
// ---------------------------------------------------------------------------

export interface PrLinkedDeps {
  /** Find project-repo rows matching an owner/repo pair (case-insensitive). */
  findByOwnerRepo: (owner: string, repo: string) => Promise<Array<{ serverId: string; projectId: string; installationId: number }>>;
  /** Parse a raw share-link id into a classified query (or null if garbage). */
  parseTaskShareId: (input: string) => TaskShareIdQuery | null;
  /** Fetch all non-deleted task rows that match the classified id. */
  resolveTaskCandidates: (query: TaskShareIdQuery) => Promise<TaskCandidate[]>;
  /** List activity entries for a task (used for idempotency check). */
  listActivity: (taskId: string) => Promise<Array<{ type: ActivityType; metadata?: Record<string, any> | null }>>;
  /** Append an activity entry to a task. */
  addActivity: (serverId: string, taskId: string, input: {
    type: ActivityType;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    createdByType?: 'member' | 'external' | 'system' | 'agent';
    createdById?: string | null;
    createdByName?: string | null;
  }) => Promise<void>;
  /** Update a task's fields (used to set status → needs_review). */
  updateTask: (serverId: string, taskId: string, input: { status: string }) => Promise<void>;
}

export interface GithubRoutesDeps {
  config: GithubAppConfig;
  /** Client SPA origin (e.g. https://app.runhq.io) — where the /github/installed page lives. */
  clientUrl: string;
  getServerByToken: (token: string) => Promise<{ id: string } | null>;
  upsertInstallation: (input: {
    installationId: number; connectedByUserId: string | null; accountLogin: string;
    accountType: 'User' | 'Organization'; repositorySelection?: 'all' | 'selected' | null;
  }) => Promise<void>;
  removeInstallation: (installationId: number) => Promise<void>;
  getInstallation: (installationId: number) => Promise<{ installationId: number; connectedByUserId: string | null } | null>;
  /** Associate an installation with a workspace (idempotent). */
  associateWithWorkspace: (installationId: number, serverId: string, addedByUserId: string | null) => Promise<void>;
  /** Whether an installation is available in (associated with) a workspace. */
  isAssociatedWithWorkspace: (installationId: number, serverId: string) => Promise<boolean>;
  mintInstallationToken: (installationId: number) => Promise<{ token: string; expiresAt: string }>;
  /** Authoritative account identity read from the GitHub App API. */
  fetchInstallationAccount: (installationId: number) => Promise<{
    accountLogin: string; accountType: 'User' | 'Organization'; repositorySelection: 'all' | 'selected' | null;
  }>;
  /** PR-linking dependencies (optional — if absent, pull_request events are no-op'd). */
  prLinked?: PrLinkedDeps;
}

// ---------------------------------------------------------------------------
// Branch → ticket-shortId extractor
// ---------------------------------------------------------------------------

const TICKET_RE = /ticket-([0-9a-f]{4,32})/i;

/** Extract the ticket shortId from a git branch name, or null if not present. */
export function extractTicketShortId(branch: string): string | null {
  const m = TICKET_RE.exec(branch);
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Core PR-linking handler (standalone for unit-testability)
// ---------------------------------------------------------------------------

export interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    html_url: string;
    state: string;
    merged: boolean;
    head: { ref: string };
  };
  repository: {
    name: string;
    owner: { login: string };
  };
}

/**
 * Handle a GitHub `pull_request` webhook event.
 *
 * Returns `'linked'` when a pr_linked activity was written, `'skipped'` for
 * intentional no-ops (wrong action, no branch match, no repo mapping, no task
 * match, already idempotent), and `'error'` on unexpected failures (caller
 * must still return 200 to GitHub).
 */
export async function handlePullRequestEvent(
  payload: PullRequestPayload,
  deps: PrLinkedDeps,
): Promise<'linked' | 'skipped' | 'error'> {
  const { action, pull_request: pr, repository } = payload;

  // Only link on open/reopen; ignore close, synchronize, etc.
  if (action !== 'opened' && action !== 'reopened') return 'skipped';

  const branch = pr.head.ref;
  const shortId = extractTicketShortId(branch);
  if (!shortId) return 'skipped';

  const owner = repository.owner.login;
  const repo = repository.name;

  // Map repo → server candidates
  const repoCandidates = await deps.findByOwnerRepo(owner, repo);
  if (repoCandidates.length === 0) return 'skipped';
  const repoServerIds = new Set(repoCandidates.map((r) => r.serverId));

  // Resolve task by shortId
  const query = deps.parseTaskShareId(shortId);
  if (!query) return 'skipped';

  const taskCandidates = await deps.resolveTaskCandidates(query);

  // Intersect: task must live on one of the repo-linked servers
  const matching = taskCandidates.filter((c) => repoServerIds.has(c.serverId));
  if (matching.length === 0) {
    if (taskCandidates.length > 0) {
      console.info('[github/pr_linked] task found but no overlapping server with repo mapping', { shortId, owner, repo });
    }
    return 'skipped';
  }

  if (matching.length > 1) {
    console.warn('[github/pr_linked] ambiguous task match — multiple tasks on repo-linked servers, skipping', {
      shortId, owner, repo, count: matching.length,
    });
    return 'skipped';
  }

  const { serverId, taskId } = matching[0];

  // Idempotency: skip if a pr_linked activity for this PR number already exists
  const existing = await deps.listActivity(taskId);
  const alreadyLinked = existing.some(
    (a) => a.type === 'pr_linked' && a.metadata?.number === pr.number,
  );
  if (alreadyLinked) return 'skipped';

  // Write the pr_linked activity + set status → needs_review
  await deps.addActivity(serverId, taskId, {
    type: 'pr_linked',
    content: `Pull request #${pr.number} opened`,
    metadata: {
      number: pr.number,
      url: pr.html_url,
      state: pr.state,
      repoBranch: branch,
    },
    createdByType: 'system',
  });

  await deps.updateTask(serverId, taskId, { status: 'needs_review' });

  console.info('[github/pr_linked] linked PR to task', { serverId, taskId, pr: pr.number, branch });
  return 'linked';
}

export function registerGithubRoutes(app: Hono, deps: GithubRoutesDeps): void {
  app.get('/api/github/setup', async (c) => {
    const installationId = Number(c.req.query('installation_id'));
    const state = c.req.query('state');
    const decoded = state ? verifyInstallState(state, deps.config.stateSecret) : null;
    if (!installationId || !decoded) {
      return c.redirect(`${deps.clientUrl}/github/installed?error=1`, 302);
    }
    // (a) record the installation (connector = whoever completed the GitHub flow).
    // The redirect is the authoritative, synchronous signal that the app was
    // installed, so we read the account identity from GitHub right here instead
    // of writing a blank placeholder and hoping the `installation` webhook later
    // backfills it — that webhook may never reach this environment, which left
    // accounts showing as blank/invisible rows. Best-effort: if the read fails
    // the row is still created (login lazily healed on next list), but never
    // overwriting a known identity (see upsertInstallation).
    let account: { accountLogin: string; accountType: 'User' | 'Organization'; repositorySelection: 'all' | 'selected' | null } = {
      accountLogin: '', accountType: 'User', repositorySelection: null,
    };
    try {
      account = await deps.fetchInstallationAccount(installationId);
    } catch {
      // Swallow — keep the install flow resilient; identity heals on next read.
    }
    await deps.upsertInstallation({
      installationId, connectedByUserId: decoded.userId,
      accountLogin: account.accountLogin, accountType: account.accountType, repositorySelection: account.repositorySelection,
    });
    // (b) make it available in the originating workspace — never overwrite a 1:1 binding.
    await deps.associateWithWorkspace(installationId, decoded.serverId, decoded.userId);
    return c.redirect(`${deps.clientUrl}/github/installed`, 302);
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
            connectedByUserId: existing.connectedByUserId,
            accountLogin: payload.installation?.account?.login ?? '',
            accountType: payload.installation?.account?.type === 'Organization' ? 'Organization' : 'User',
            repositorySelection: payload.installation?.repository_selection ?? null,
          });
        }
      }
    } else if (event === 'pull_request' && deps.prLinked) {
      try {
        await handlePullRequestEvent(payload as PullRequestPayload, deps.prLinked);
      } catch (err) {
        // Always 200 to GitHub; log the error but don't surface it.
        console.error('[github/pull_request] unexpected error in handler', err);
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

    // Workspace-shared: any workspace the installation is associated with may mint
    // a token. Membership + manage_project is enforced at the runhq layer.
    if (!(await deps.isAssociatedWithWorkspace(installationId, serverId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const minted = await deps.mintInstallationToken(installationId);
    return c.json(minted);
  });
}
