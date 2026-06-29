import type { Hono } from 'hono';
import { verifyGithubWebhook } from './verifyWebhook.js';
import { verifyInstallState } from './installState.js';
import type { GithubAppConfig } from './config.js';
import type { ActivityType, CanonicalTaskStatus } from '@runhq/server-protocol';
import { todoStatusRank } from '@runhq/server-protocol';
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
  /** Update a task's fields (e.g. set status → done / reviewed / merged). */
  updateTask: (serverId: string, taskId: string, input: { status: CanonicalTaskStatus }) => Promise<void>;
  /** Replace the metadata of an existing activity row (used to update PR state on close/merge). */
  updateActivityMetadata: (activityId: string, metadata: Record<string, unknown>) => Promise<void>;
  /**
   * Read a task's current status — used to gate monotonic status writes so a
   * late/duplicate webhook never downgrades a further-along task. Optional for
   * version skew; when absent the guard is skipped (write proceeds).
   */
  getTask?: (serverId: string, taskId: string) => Promise<{ status: CanonicalTaskStatus } | null>;
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
 * Advance a task's status to `target` only when it is strictly forward in the
 * lifecycle (monotonic). Reads the current status via `deps.getTask` and skips
 * the write when the task is already at or past `target` — so a late or
 * duplicate webhook never downgrades a further-along task (e.g. an `approved`
 * review arriving after merge must not move `merged` back to `reviewed`). When
 * no task read is available the guard is skipped and the write proceeds.
 *
 * Note: env ordering is not known here (deploy environments live on the runhq
 * side), so ranking uses the default base ordering — sufficient for the base
 * phases this handler writes (done/reviewed/merged) and the terminal deploy
 * statuses which always out-rank them.
 */
async function maybeAdvanceTaskStatus(
  serverId: string,
  taskId: string,
  target: CanonicalTaskStatus,
  deps: PrLinkedDeps,
): Promise<boolean> {
  const current = await deps.getTask?.(serverId, taskId);
  if (current && todoStatusRank(current.status) >= todoStatusRank(target)) {
    return false;
  }
  await deps.updateTask(serverId, taskId, { status: target });
  return true;
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

    // Write the pr_linked activity + set status → done ("work complete, PR up,
    // awaiting review"). Guard monotonically so a re-opened PR on an already
    // merged/deployed task never drags it backwards.
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

    await maybeAdvanceTaskStatus(serverId, taskId, 'done', deps);

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

    // A merged PR advances the task → merged (monotonic, never downgrades a task
    // already at/past merged, e.g. one already deployed:<env>).
    if (pr.merged) {
      await maybeAdvanceTaskStatus(resolved.serverId, taskId, 'merged', deps);
    }

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
// Pull-request review → set task `reviewed` on approval
// ---------------------------------------------------------------------------

export interface PullRequestReviewPayload {
  action: string;
  review: {
    /** GitHub sends e.g. 'approved' | 'changes_requested' | 'commented' | 'dismissed'. */
    state: string;
    user?: { login?: string } | null;
  };
  pull_request: PullRequestPayload['pull_request'];
  repository: PullRequestPayload['repository'];
}

/**
 * Handle a GitHub `pull_request_review` webhook event.
 *
 * Only a *submitted* + *approved* review advances the linked task → `reviewed`
 * (monotonic — never downgrades a task already at/past reviewed, e.g. one that
 * has since been merged or deployed). All other review states (commented,
 * changes_requested, dismissed) and unresolvable PRs are quiet no-ops, matching
 * the `pull_request` handler's behavior.
 *
 * NOTE (ops): the GitHub App must be subscribed to the `pull_request_review`
 * event in its settings for this to fire — no code can enable that subscription.
 *
 * Returns `'reviewed'` when the status was advanced, `'skipped'` for an
 * intentional no-op, and `'error'` on unexpected failure (caller still 200s).
 */
export async function handlePullRequestReviewEvent(
  payload: PullRequestReviewPayload,
  deps: PrLinkedDeps,
): Promise<'reviewed' | 'skipped' | 'error'> {
  if (payload.action !== 'submitted') return 'skipped';
  if ((payload.review?.state ?? '').toLowerCase() !== 'approved') return 'skipped';

  const resolved = await resolvePrTask(payload.pull_request, payload.repository, deps);
  if (!resolved) return 'skipped';
  const { serverId, taskId } = resolved;

  // Monotonic guard up front so an approval arriving after merge/deploy neither
  // writes a noisy pr_reviewed activity nor downgrades the status.
  const current = await deps.getTask?.(serverId, taskId);
  if (current && todoStatusRank(current.status) >= todoStatusRank('reviewed')) {
    return 'skipped';
  }

  await deps.addActivity(serverId, taskId, {
    type: 'pr_reviewed',
    content: `Pull request #${payload.pull_request.number} approved`,
    metadata: {
      number: payload.pull_request.number,
      url: payload.pull_request.html_url,
      reviewer: payload.review?.user?.login ?? null,
    },
    createdByType: 'system',
  });
  await deps.updateTask(serverId, taskId, { status: 'reviewed' });

  console.info('[github/pr_reviewed] approved PR advanced task → reviewed', {
    serverId, taskId, pr: payload.pull_request.number,
  });
  return 'reviewed';
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

export interface PushEventDeps extends ReadyPullRequestDeps {
  findByOwnerRepo: (owner: string, repo: string) => Promise<Array<{ serverId: string; projectId: string; installationId: number }>>;
  parseTaskShareId: (input: string) => TaskShareIdQuery | null;
  resolveTaskCandidates: (query: TaskShareIdQuery) => Promise<TaskCandidate[]>;
  /** Fetch a task's persistent fields for platform-owned logic (e.g. useWorktree). */
  getTask: (serverId: string, taskId: string) => Promise<{ useWorktree: boolean } | null>;
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
  // Only an *open* PR means this branch is already covered. A merged/closed PR
  // is terminal — continued work on the branch needs a fresh PR later — so it
  // must not block re-recording the branch.
  if (hasOpenLinkedPr(activity, branch)) return 'skipped';

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
  } catch (err) {
    console.warn('[github/push] failed to record pushed ticket branch', { owner, repo, branch, err: (err as Error)?.message });
    return 'error';
  }

  // Recording succeeded — the function is now committed to returning 'recorded'.
  // Platform-owned PR creation: a pushed isolated-branch task gets a draft PR,
  // independent of whether the agent ever runs `runhq ready-for-review`. The
  // useWorktree lookup + draft open is a fully self-contained fire-and-forget:
  // BOTH a getTask rejection (e.g. transient DB error) and an open failure are
  // caught here, so neither can change the return value or throw after the
  // branch_pushed activity was already written.
  void (async () => {
    const full = await deps.getTask(task.serverId, task.taskId);
    if (full?.useWorktree) {
      await openPullRequestForReadyTask(task.serverId, task.taskId, deps, { mode: 'draft' });
    }
  })().catch((err) => console.warn('[github/push] draft PR open failed', { taskId: task.taskId, err: (err as Error)?.message }));
  return 'recorded';
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
  findOpenPullRequestByHead: (installationId: number, owner: string, repo: string, head: string) => Promise<{ number: number; url: string; nodeId: string; isDraft: boolean } | null>;
  createPullRequest: (installationId: number, owner: string, repo: string, args: { title: string; head: string; base: string; body?: string; draft?: boolean }) => Promise<{ number: number; url: string; nodeId: string }>;
  markPullRequestReady: (installationId: number, nodeId: string) => Promise<void>;
  /** Optional — push a live `pr:linked` notification to the workspace server so
   *  its "PR #N" chip updates without a page refresh. Best-effort; failures must
   *  never break PR creation. */
  notifyPrLinked?: (serverId: string, input: { branch: string; number: number; url: string; state: 'open' | 'closed' | 'merged' }) => Promise<void>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A ticket branch has a *live* pull request only while its latest `pr_linked`
 * activity is still open. Merged and closed PRs are terminal on GitHub — a
 * merged PR never reopens, and a branch pushed again after merge needs a brand
 * new PR — so a resolved `pr_linked` must NOT suppress recording further pushes
 * or opening a fresh PR for continued work. (PRs predating the `state` field
 * are treated as open, the safe default that avoids opening a duplicate.)
 *
 * Pass `branch` to scope the check to one ticket branch (push handler); omit it
 * to ask "does this task have any open PR at all?" (ready handler — a task only
 * ever drives one ticket branch).
 */
function hasOpenLinkedPr(
  activity: Array<{ type: ActivityType; metadata?: Record<string, any> | null }>,
  branch?: string,
): boolean {
  return activity.some(
    (a) =>
      a.type === 'pr_linked' &&
      typeof a.metadata?.number === 'number' &&
      (a.metadata?.state ?? 'open') === 'open' &&
      (branch === undefined || a.metadata?.repoBranch === branch),
  );
}

/**
 * Outcome of {@link openPullRequestForReadyTask}. `reason` (skipped) and
 * `message` (error) carry a human-readable explanation so callers can surface
 * *why* nothing opened instead of failing silently.
 */
export type ReadyPrResult =
  | { status: 'opened' | 'linked_existing' | 'marked_ready'; prNumber: number; url: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; message: string };

/**
 * Open/link a PR for a task whose branch was pushed or marked ready.
 *
 * mode='draft'  (push webhook): ensure a draft PR exists; do NOT change task
 *               status. Idempotent — returns 'linked_existing' when an open PR
 *               is already present, 'skipped' when pr_linked is already recorded.
 *
 * mode='ready'  (done-signal, default): un-draft an existing PR if needed,
 *               ensure pr_linked is written, then set status to done.
 *               The early existingLinked short-circuit is intentionally absent
 *               here so that a draft opened on push is always promoted.
 */
export async function openPullRequestForReadyTask(
  serverId: string,
  taskId: string,
  deps: ReadyPullRequestDeps,
  opts?: { mode?: 'draft' | 'ready'; createIfMissing?: boolean },
): Promise<ReadyPrResult> {
  const mode = opts?.mode ?? 'ready';
  const createIfMissing = opts?.createIfMissing ?? true;
  const activity = await deps.listActivity(taskId);

  const branchActivity = [...activity].reverse().find((a) => a.type === 'branch_pushed' && a.metadata);
  const metadata = branchActivity?.metadata ?? null;
  if (!metadata) {
    return { status: 'skipped', reason: 'No pushed commits found for this branch yet — commit and push your changes, then try again.' };
  }

  const owner = readString(metadata.owner);
  const repo = readString(metadata.repo);
  const branch = readString(metadata.branch);
  const base = readString(metadata.base);
  const title = readString(metadata.title) ?? 'RunHQ ticket';
  const shortId = readString(metadata.shortId) ?? taskId.slice(0, 8);
  const installationId = readNumber(metadata.installationId);
  if (!owner || !repo || !branch || !base || !installationId || branch === base) {
    return { status: 'skipped', reason: "This branch can't be opened as a pull request (missing or invalid branch info)." };
  }

  try {
    const existing = await deps.findOpenPullRequestByHead(installationId, owner, repo, branch);

    // ── DRAFT mode (push webhook): ensure a draft PR exists, no status change ──
    if (mode === 'draft') {
      if (existing) {
        return { status: 'linked_existing', prNumber: existing.number, url: existing.url };
      }
      if (hasOpenLinkedPr(activity, branch)) {
        return { status: 'skipped', reason: 'A pull request is already open for this branch.' };
      }
      const pr = await deps.createPullRequest(installationId, owner, repo, {
        title,
        head: branch,
        base,
        draft: true,
        body: `Automated draft pull request for ticket \`${shortId}\`: ${title}\n\nOpened by RunHQ when the ticket branch was pushed. It is marked ready for review when the agent signals completion.`,
      });
      await writePrLinked(serverId, taskId, branch, pr.number, pr.url, deps);
      await notify(deps, serverId, branch, pr.number, pr.url);
      console.info('[github/draft] opened draft PR for ticket branch', { owner, repo, branch, taskId, pr: pr.number });
      return { status: 'opened', prNumber: pr.number, url: pr.url };
    }

    // ── READY mode (done-signal): un-draft if needed, ensure linked, set status ──
    let number: number;
    let url: string;
    let resultStatus: 'opened' | 'marked_ready';
    if (existing) {
      number = existing.number;
      url = existing.url;
      if (existing.isDraft) {
        await deps.markPullRequestReady(installationId, existing.nodeId);
      }
      resultStatus = 'marked_ready';
    } else {
      // createIfMissing:false is used for heuristic job-completion: only promote
      // an EXISTING draft PR, never open one from a plain 'done' signal.
      if (!createIfMissing) {
        return { status: 'skipped', reason: 'No open pull request to mark ready.' };
      }
      const pr = await deps.createPullRequest(installationId, owner, repo, {
        title,
        head: branch,
        base,
        draft: false,
        body: `Automated pull request for widget ticket \`${shortId}\`: ${title}\n\nOpened by RunHQ after the coding agent marked its ticket branch ready for review.`,
      });
      number = pr.number;
      url = pr.url;
      resultStatus = 'opened';
    }

    const latest = await deps.listActivity(taskId);
    if (!latest.some((a) => a.type === 'pr_linked' && a.metadata?.number === number)) {
      await writePrLinked(serverId, taskId, branch, number, url, deps);
    }
    await deps.updateTask(serverId, taskId, { status: 'done' });
    await notify(deps, serverId, branch, number, url);

    console.info(existing ? '[github/ready] marked PR ready for review for ticket branch' : '[github/ready] opened PR for ready ticket branch', {
      owner,
      repo,
      branch,
      taskId,
      pr: number,
    });
    return { status: resultStatus, prNumber: number, url };
  } catch (err) {
    const message = (err as Error)?.message || 'GitHub rejected the request.';
    console.warn('[github/ready] failed to open/ready PR for ticket branch', { owner, repo, branch, taskId, err: message });
    return { status: 'error', message };
  }
}

async function writePrLinked(serverId: string, taskId: string, branch: string, number: number, url: string, deps: ReadyPullRequestDeps): Promise<void> {
  await deps.addActivity(serverId, taskId, {
    type: 'pr_linked',
    content: `Pull request #${number} opened`,
    metadata: { number, url, state: 'open', repoBranch: branch },
    createdByType: 'system',
  });
}

async function notify(deps: ReadyPullRequestDeps, serverId: string, branch: string, number: number, url: string): Promise<void> {
  if (!deps.notifyPrLinked) return;
  try {
    await deps.notifyPrLinked(serverId, { branch, number, url, state: 'open' });
  } catch (err) {
    console.warn('[github/ready] pr-linked workspace notify failed', { branch, err: (err as Error)?.message });
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
    } else if (event === 'pull_request_review' && deps.prLinked) {
      try {
        await handlePullRequestReviewEvent(payload as PullRequestReviewPayload, deps.prLinked);
      } catch (err) {
        // Always 200 to GitHub; log the error but don't surface it.
        console.error('[github/pull_request_review] unexpected error in handler', err);
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
