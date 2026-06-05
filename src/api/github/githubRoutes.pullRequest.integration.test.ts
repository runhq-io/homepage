/**
 * Real-DB integration tests for the pull_request webhook handler.
 *
 * Seeds: server + workspace_task + github_app_installation +
 *        github_project_repos.
 * Verifies: pr_linked activity written, task status set to needs_review,
 * and idempotency (two firings → one activity row).
 *
 * DATABASE_URL must point at the scratch Postgres DB (runhq_clarifier_test).
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  workspaceTasks,
  workspaceTaskActivity,
  githubAppInstallations,
  githubProjectRepos,
} from '../../db/schema';
import {
  handlePullRequestEvent,
  type PullRequestPayload,
} from './githubRoutes.js';
import {
  parseTaskShareId,
  resolveTaskCandidates,
  listActivity,
  addActivity,
  updateTask,
} from '../services/WorkspaceTaskService.js';
import { findByOwnerRepo } from '../services/GithubProjectReposService.js';

// ---------------------------------------------------------------------------
// Test fixture IDs (randomised per run to avoid cross-test pollution)
// ---------------------------------------------------------------------------

const RUN = randomBytes(5).toString('hex');
const SERVER_ID = `ws_prlink_${RUN}`;
const OWNER_ID = `00000000-0001-4000-b100-${RUN.padStart(12, '0')}`;
const INSTALL_ID = Math.floor(Math.random() * 900000) + 100000;
const OWNER = 'acme';
const REPO = 'web';
const PROJECT_ID = `tank_prlink_${RUN}`;

let TASK_ID: string;
let TASK_SHORT_ID: string;
let BRANCH: string;

// ---------------------------------------------------------------------------
// Seed & teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // user
  await db.insert(users).values({ id: OWNER_ID, email: `prlink+${RUN}@test.invalid`, name: 'PR Link Test' }).onConflictDoNothing();

  // server
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN}`, ownerId: OWNER_ID }).onConflictDoNothing();

  // workspace task — use a known prefix so branch contains it
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    title: 'My widget ticket',
    status: 'in_progress',
    visibility: 'public',
    sourceType: 'widget',
    createdByType: 'external',
  }).returning({ id: workspaceTasks.id });
  if (!task) throw new Error('task seed failed');

  TASK_ID = task.id;
  TASK_SHORT_ID = TASK_ID.replace(/-/g, '').slice(0, 8);
  BRANCH = `session/job_test_${RUN}/ticket-${TASK_SHORT_ID}`;

  // GitHub app installation
  await db.insert(githubAppInstallations).values({
    installationId: INSTALL_ID,
    connectedByUserId: OWNER_ID,
    accountLogin: OWNER,
    accountType: 'Organization',
    repositorySelection: 'all',
  }).onConflictDoNothing();

  // project repo link  (server ↔ owner/repo)
  await db.insert(githubProjectRepos).values({
    serverId: SERVER_ID,
    projectId: PROJECT_ID,
    installationId: INSTALL_ID,
    owner: OWNER,
    repo: REPO,
  }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, TASK_ID)).catch(() => {});
  await db.delete(workspaceTasks).where(eq(workspaceTasks.id, TASK_ID)).catch(() => {});
  await db.delete(githubProjectRepos).where(
    and(eq(githubProjectRepos.serverId, SERVER_ID), eq(githubProjectRepos.projectId, PROJECT_ID)),
  ).catch(() => {});
  await db.delete(githubAppInstallations).where(eq(githubAppInstallations.installationId, INSTALL_ID)).catch(() => {});
  await db.delete(servers).where(eq(servers.id, SERVER_ID)).catch(() => {});
  await db.delete(users).where(eq(users.id, OWNER_ID)).catch(() => {});
});

// ---------------------------------------------------------------------------
// Build the real deps shim
// ---------------------------------------------------------------------------

function realDeps() {
  return {
    findByOwnerRepo,
    parseTaskShareId,
    resolveTaskCandidates,
    listActivity,
    addActivity: async (serverId: string, taskId: string, input: Parameters<typeof addActivity>[2]) => {
      await addActivity(serverId, taskId, input);
    },
    updateTask: async (serverId: string, taskId: string, input: { status: string }) => {
      await updateTask(serverId, taskId, input as any);
    },
  };
}

function makePayload(overrides: {
  action?: string;
  number?: number;
  branch?: string;
  owner?: string;
  repo?: string;
} = {}): PullRequestPayload {
  const prNum = overrides.number ?? 101;
  return {
    action: overrides.action ?? 'opened',
    pull_request: {
      number: prNum,
      html_url: `https://github.com/${overrides.owner ?? OWNER}/${overrides.repo ?? REPO}/pull/${prNum}`,
      state: 'open',
      merged: false,
      head: { ref: overrides.branch ?? BRANCH },
    },
    repository: {
      name: overrides.repo ?? REPO,
      owner: { login: overrides.owner ?? OWNER },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pull_request webhook — real DB integration', () => {
  it('findByOwnerRepo returns the seeded repo link', async () => {
    const rows = await findByOwnerRepo(OWNER, REPO);
    expect(rows.some((r) => r.serverId === SERVER_ID)).toBe(true);
  });

  it('findByOwnerRepo is case-insensitive', async () => {
    const rows = await findByOwnerRepo(OWNER.toUpperCase(), REPO.toUpperCase());
    expect(rows.some((r) => r.serverId === SERVER_ID)).toBe(true);
  });

  it('happy path: writes pr_linked activity and sets task status to needs_review', async () => {
    const result = await handlePullRequestEvent(makePayload({ number: 101 }), realDeps());
    expect(result).toBe('linked');

    // activity row written
    const activity = await listActivity(TASK_ID);
    const linked = activity.filter((a) => a.type === 'pr_linked' && a.metadata?.number === 101);
    expect(linked).toHaveLength(1);
    expect(linked[0].metadata?.url).toContain('/pull/101');
    expect(linked[0].metadata?.state).toBe('open');
    expect(linked[0].metadata?.repoBranch).toBe(BRANCH);

    // task status updated
    const [row] = await db.select({ status: workspaceTasks.status }).from(workspaceTasks)
      .where(eq(workspaceTasks.id, TASK_ID));
    expect(row?.status).toBe('needs_review');
  });

  it('idempotency: firing the same PR opened event twice produces only one pr_linked activity', async () => {
    // First call was already done in the previous test; fire again.
    const result = await handlePullRequestEvent(makePayload({ number: 101 }), realDeps());
    expect(result).toBe('skipped');

    const activity = await listActivity(TASK_ID);
    const linked = activity.filter((a) => a.type === 'pr_linked' && a.metadata?.number === 101);
    expect(linked).toHaveLength(1); // still exactly one
  });

  it('a second PR (different number) is linked as a second activity', async () => {
    const result = await handlePullRequestEvent(makePayload({ number: 202 }), realDeps());
    expect(result).toBe('linked');

    const activity = await listActivity(TASK_ID);
    const linked202 = activity.filter((a) => a.type === 'pr_linked' && a.metadata?.number === 202);
    expect(linked202).toHaveLength(1);
  });

  it('no-op when repo owner/repo has no mapping in github_project_repos', async () => {
    const result = await handlePullRequestEvent(
      makePayload({ owner: 'unknown-org', repo: 'nonexistent-repo' }),
      realDeps(),
    );
    expect(result).toBe('skipped');
  });

  it('no-op when branch contains no ticket- fragment', async () => {
    const result = await handlePullRequestEvent(
      makePayload({ branch: 'feat/some-feature' }),
      realDeps(),
    );
    expect(result).toBe('skipped');
  });

  it('no-op for action=closed', async () => {
    const activityBefore = await listActivity(TASK_ID);
    const result = await handlePullRequestEvent(
      makePayload({ action: 'closed', number: 999 }),
      realDeps(),
    );
    expect(result).toBe('skipped');
    const activityAfter = await listActivity(TASK_ID);
    expect(activityAfter).toHaveLength(activityBefore.length);
  });
});
