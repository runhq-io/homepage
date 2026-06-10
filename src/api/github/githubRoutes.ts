import type { Hono } from 'hono';
import { verifyGithubWebhook } from './verifyWebhook.js';
import { verifyInstallState } from './installState.js';
import type { GithubAppConfig } from './config.js';
import type { ActivityType, CanonicalTaskStatus } from '@runhq/server-protocol';
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
  /** List activity entries for a task (used for idempotency check and state updates). */
  listActivity: (taskId: string) => Promise<Array<{ id: string; type: ActivityType; metadata?: Record<string, any> | null }>>;
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
  updateTask: (serverId: string, taskId: string, input: { status: CanonicalTaskStatus }) => Promise<void>;
  /** Replace the metadata of an existing activity row (used to update PR state on close/merge). */
  updateActivityMetadata: (activityId: string, metadata: Record<string, unknown>) => Promise<void>;
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
  /** Branch-recording dependencies for push events (optional — if absent, push events are no-op'd). */
  pushHandling?: PushEventDeps;
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

// ---------------------------------------------------------------------------
// Shared resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve the unique task that should receive a PR event, or return null for
 * any intentional no-op (no branch match, no repo mapping, no task match,
 * ambiguous match).
 */
async function resolvePrTask(
  pr: PullRequestPayload['pull_request'],
  repository: PullRequestPayload['repository'],
  deps: PrLinkedDeps,
): Promise<{ serverId: string; taskId: string; branch: string } | null> {
  const branch = pr.head.ref;
  const shortId = extractTicketShortId(branch);
  if (!shortId) return null;

  const owner = repository.owner.login;
  const repo = repository.name;

  const repoCandidates = await deps.findByOwnerRepo(owner, repo);
  if (repoCandidates.length === 0) return null;
  const repoServerIds = new Set(repoCandidates.map((r) => r.serverId));

  const query = deps.parseTaskShareId(shortId);
  if (!query) return null;

  const taskCandidates = await deps.resolveTaskCandidates(query);

  const matching = taskCandidates.filter((c) => repoServerIds.has(c.serverId));
  if (matching.length === 0) {
    if (taskCandidates.length > 0) {
      console.info('[github/pr_linked] task found but no overlapping server with repo mapping', { shortId, owner, repo });
    }
    return null;
  }

  if (matching.length > 1) {
    console.warn('[github/pr_linked] ambiguous task match — multiple tasks on repo-linked servers, skipping', {
      shortId, owner, repo, count: matching.length,
    });
    return null;
  }

  return { serverId: matching[0].serverId, taskId: matching[0].taskId, branch };
}

/**
 * Handle a GitHub `pull_request` webhook event.
 *
 * Returns `'linked'` when a pr_linked activity was written, `'updated'` when
 * an existing activity's state was updated on close/merge, `'skipped'` for
 * intentional no-ops (wrong action, no branch match, no repo mapping, no task
 * match, already idempotent), and `'error'` on unexpected failures (caller
 * must still return 200 to GitHub).
 */
export async function handlePullRequestEvent(
  payload: PullRequestPayload,
  deps: PrLinkedDeps,
): Promise<'linked' | 'updated' | 'skipped' | 'error'> {
  const { action, pull_request: pr, repository } = payload;

  // ── Opened / Reopened ────────────────────────────────────────────────────
  if (action === 'opened' || action === 'reopened') {
    const resolved = await resolvePrTask(pr, repository, deps);
    if (!resolved) return 'skipped';

    const { serverId, taskId, branch } = resolved;

    // Idempotency: skip if a pr_linked activity for this PR number already exists.
    // Exception: on `reopened`, reset the existing activity's state back to 'open'
    // so a close→reopen cycle is reflected correctly.
    const existing = await deps.listActivity(taskId);
    const linkedActivity = existing.find(
      (a) => a.type === 'pr_linked' && a.metadata?.number === pr.number,
    );
    const alreadyLinked = !!linkedActivity;
    if (alreadyLinked) {
      if (action === 'reopened') {
        const updatedMetadata = { ...(linkedActivity!.metadata ?? {}), state: 'open' };
        await deps.updateActivityMetadata(linkedActivity!.id, updatedMetadata);
        console.info('[github/pr_linked] reset PR state to open on task activity', {
          taskId,
          pr: pr.number,
        });
        return 'updated';
      }
      return 'skipped';
    }

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

  // ── Closed (merged or just closed) ───────────────────────────────────────
  if (action === 'closed') {
    const resolved = await resolvePrTask(pr, repository, deps);
    if (!resolved) return 'skipped';

    const { taskId } = resolved;

    // Find the existing pr_linked activity for this PR number
    const existing = await deps.listActivity(taskId);
    const linkedActivity = existing.find(
      (a) => a.type === 'pr_linked' && a.metadata?.number === pr.number,
    );
    if (!linkedActivity) {
      // Never linked — no-op
      return 'skipped';
    }

    const newState = pr.merged ? 'merged' : 'closed';
    const updatedMetadata = { ...(linkedActivity.metadata ?? {}), state: newState };
    await deps.updateActivityMetadata(linkedActivity.id, updatedMetadata);

    console.info('[github/pr_linked] updated PR state on task activity', {
      taskId,
      pr: pr.number,
      newState,
    });
    return 'updated';
  }

  // All other actions (synchronize, labeled, review_requested, etc.) → no-op
  return 'skipped';
}

// ---------------------------------------------------------------------------
// Push → record ticket branch
// ---------------------------------------------------------------------------

export interface PushPayload {
  /** e.g. "refs/heads/session/job_x/ticket-abcd1234" */
  ref: string;
  /** GitHub sets this true when the ref was deleted by the push. */
  deleted?: boolean;
  repository: {
    name: string;
    owner: { login: string };
    default_branch: string;
  };
}

export interface PushEventDeps {
  findByOwnerRepo: (owner: string, repo: string) => Promise<Array<{ serverId: string; projectId: string; installationId: number }>>;
  parseTaskShareId: (input: string) => TaskShareIdQuery | null;
  resolveTaskCandidates: (query: TaskShareIdQuery) => Promise<TaskCandidate[]>;
  /** List activity entries for a task (used for idempotency). */
  listActivity: (taskId: string) => Promise<Array<{ id: string; type: ActivityType; metadata?: Record<string, any> | null }>>;
  /** Append an activity entry to a task. */
  addActivity: (serverId: string, taskId: string, input: {
    type: ActivityType;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    createdByType?: 'member' | 'external' | 'system' | 'agent';
    createdById?: string | null;
    createdByName?: string | null;
  }) => Promise<void>;
}

/**
 * Handle a GitHub `push` webhook by recording the latest pushed ticket branch.
 * Push is progress, not readiness: the coding agent can push multiple times
 * before it is done. RunHQ opens the PR later, when the task is explicitly
 * marked ready by the workspace server.
 *
 * Returns `'recorded'`, `'skipped'` (intentional no-op), or `'error'`.
 * NEVER throws.
 */
export async function handlePushEvent(
  payload: PushPayload,
  deps: PushEventDeps,
): Promise<'recorded' | 'skipped' | 'error'> {
  const PREFIX = 'refs/heads/';
  if (!payload.ref || !payload.ref.startsWith(PREFIX)) return 'skipped'; // tags / non-branch refs
  if (payload.deleted) return 'skipped'; // branch deletion
  const branch = payload.ref.slice(PREFIX.length);

  const shortId = extractTicketShortId(branch);
  if (!shortId) return 'skipped';

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const base = payload.repository.default_branch;
  if (!base || branch === base) return 'skipped'; // never PR the base into itself

  const repoCandidates = await deps.findByOwnerRepo(owner, repo);
  if (repoCandidates.length === 0) return 'skipped';
  const repoServerIds = new Set(repoCandidates.map((r) => r.serverId));

  const query = deps.parseTaskShareId(shortId);
  if (!query) return 'skipped';
  const taskCandidates = await deps.resolveTaskCandidates(query);
  const matching = taskCandidates.filter((c) => repoServerIds.has(c.serverId));
  if (matching.length !== 1) return 'skipped'; // no match, or ambiguous

  const task = matching[0]!;
  const installationId = repoCandidates.find((r) => r.serverId === task.serverId)!.installationId;
  const projectId = repoCandidates.find((r) => r.serverId === task.serverId)?.projectId ?? null;

  const activity = await deps.listActivity(task.taskId);
  const alreadyLinked = activity.some((a) =>
    a.type === 'pr_linked' && a.metadata?.repoBranch === branch);
  if (alreadyLinked) return 'skipped';

  const alreadyRecorded = activity.some((a) =>
    a.type === 'branch_pushed' && a.metadata?.branch === branch);
  if (alreadyRecorded) return 'skipped';

  try {
    await deps.addActivity(task.serverId, task.taskId, {
      type: 'branch_pushed',
      content: `Branch ${branch} pushed`,
      metadata: {
        shortId,
        owner,
        repo,
        branch,
        base,
        installationId,
        projectId,
        title: task.title,
      },
      createdByType: 'system',
    });
    console.info('[github/push] recorded pushed ticket branch', { owner, repo, branch, taskId: task.taskId });
    return 'recorded';
  } catch (err) {
    console.warn('[github/push] failed to record pushed ticket branch', { owner, repo, branch, err: (err as Error)?.message });
    return 'error';
  }
}

export interface ReadyPullRequestDeps {
  listActivity: (taskId: string) => Promise<Array<{ id: string; type: ActivityType; metadata?: Record<string, any> | null }>>;
  addActivity: (serverId: string, taskId: string, input: {
    type: ActivityType;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    createdByType?: 'member' | 'external' | 'system' | 'agent';
    createdById?: string | null;
    createdByName?: string | null;
  }) => Promise<void>;
  updateTask: (serverId: string, taskId: string, input: { status: CanonicalTaskStatus }) => Promise<void>;
  findOpenPullRequestByHead: (installationId: number, owner: string, repo: string, head: string) => Promise<{ number: number; url: string } | null>;
  createPullRequest: (installationId: number, owner: string, repo: string, args: { title: string; head: string; base: string; body?: string }) => Promise<{ number: number; url: string }>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Open/link a PR for a task that has been explicitly marked ready. This uses
 * the latest branch recorded by the push webhook, so repeated pushes before
 * readiness do not create noisy under-progress PRs.
 */
export async function openPullRequestForReadyTask(
  serverId: string,
  taskId: string,
  deps: ReadyPullRequestDeps,
): Promise<'opened' | 'linked_existing' | 'skipped' | 'error'> {
  const activity = await deps.listActivity(taskId);
  const existingLinked = activity.find((a) => a.type === 'pr_linked' && typeof a.metadata?.number === 'number');
  if (existingLinked) return 'skipped';

  const branchActivity = [...activity].reverse().find((a) => a.type === 'branch_pushed' && a.metadata);
  const metadata = branchActivity?.metadata ?? null;
  if (!metadata) return 'skipped';

  const owner = readString(metadata.owner);
  const repo = readString(metadata.repo);
  const branch = readString(metadata.branch);
  const base = readString(metadata.base);
  const title = readString(metadata.title) ?? 'RunHQ ticket';
  const shortId = readString(metadata.shortId) ?? taskId.slice(0, 8);
  const installationId = readNumber(metadata.installationId);
  if (!owner || !repo || !branch || !base || !installationId || branch === base) return 'skipped';

  try {
    const existing = await deps.findOpenPullRequestByHead(installationId, owner, repo, branch);
    const pr = existing ?? await deps.createPullRequest(installationId, owner, repo, {
      title,
      head: branch,
      base,
      body: `Automated pull request for widget ticket \`${shortId}\`: ${title}\n\nOpened by RunHQ after the coding agent marked its ticket branch ready for review.`,
    });

    const latestActivity = await deps.listActivity(taskId);
    const alreadyLinked = latestActivity.some((a) => a.type === 'pr_linked' && a.metadata?.number === pr.number);
    if (!alreadyLinked) {
      await deps.addActivity(serverId, taskId, {
        type: 'pr_linked',
        content: `Pull request #${pr.number} opened`,
        metadata: {
          number: pr.number,
          url: pr.url,
          state: 'open',
          repoBranch: branch,
        },
        createdByType: 'system',
      });
    }

    await deps.updateTask(serverId, taskId, { status: 'needs_review' });
    console.info(existing ? '[github/ready] linked existing PR for ready ticket branch' : '[github/ready] opened PR for ready ticket branch', {
      owner,
      repo,
      branch,
      taskId,
      pr: pr.number,
    });
    return existing ? 'linked_existing' : 'opened';
  } catch (err) {
    console.warn('[github/ready] failed to open PR for ready ticket branch', { owner, repo, branch, taskId, err: (err as Error)?.message });
    return 'error';
  }
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
    } else if (event === 'push' && deps.pushHandling) {
      try {
        await handlePushEvent(payload as PushPayload, deps.pushHandling);
      } catch (err) {
        // handlePushEvent never throws, but keep the route bulletproof → always 200.
        console.error('[github/push] unexpected error in handler', err);
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
