import { describe, it, expect, vi } from 'vitest';
import {
  handlePushEvent,
  openPullRequestForReadyTask,
  type PushEventDeps,
  type PushPayload,
  type ReadyPullRequestDeps,
} from './githubRoutes';

const REPO = { name: 'app', owner: { login: 'acme' }, default_branch: 'main' };

function makeDeps(over: Partial<PushEventDeps> = {}): PushEventDeps {
  return {
    findByOwnerRepo: vi.fn().mockResolvedValue([{ serverId: 'ws_1', projectId: 'p_1', installationId: 42 }]),
    parseTaskShareId: vi.fn().mockReturnValue({ kind: 'shortId', value: 'abcd1234' }),
    resolveTaskCandidates: vi.fn().mockResolvedValue([
      { serverId: 'ws_1', channelId: null, taskId: 'task_1', title: 'Add dark mode', legacyWorkspaceTodoId: null, createdAt: 1 },
    ]),
    listActivity: vi.fn().mockResolvedValue([]),
    addActivity: vi.fn().mockResolvedValue(undefined),
    // getTask defaults to non-worktree so existing tests do NOT trigger PR creation
    getTask: vi.fn().mockResolvedValue({ useWorktree: false }),
    // ReadyPullRequestDeps fields — provided as no-op defaults
    updateTask: vi.fn().mockResolvedValue(undefined),
    findOpenPullRequestByHead: vi.fn().mockResolvedValue(null),
    createPullRequest: vi.fn().mockResolvedValue({ number: 7, url: 'u', headRef: 'session/job_x/ticket-abcd1234', nodeId: 'PR_node' }),
    markPullRequestReady: vi.fn().mockResolvedValue(undefined),
    notifyPrLinked: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const push = (over: Partial<PushPayload> = {}): PushPayload => ({
  ref: 'refs/heads/session/job_x/ticket-abcd1234',
  deleted: false,
  repository: REPO,
  ...over,
});

describe('handlePushEvent', () => {
  it('records a pushed ticket branch without opening a PR', async () => {
    const deps = makeDeps();
    const result = await handlePushEvent(push(), deps);
    expect(result).toBe('recorded');
    expect(deps.addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({
      type: 'branch_pushed',
      metadata: expect.objectContaining({
        branch: 'session/job_x/ticket-abcd1234',
        base: 'main',
        title: 'Add dark mode',
      }),
    }));
  });

  it('skips a non-branch ref (tag push)', async () => {
    const deps = makeDeps();
    expect(await handlePushEvent(push({ ref: 'refs/tags/v1' }), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('skips a branch deletion', async () => {
    const deps = makeDeps();
    expect(await handlePushEvent(push({ deleted: true }), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('skips a non-ticket branch', async () => {
    const deps = makeDeps();
    expect(await handlePushEvent(push({ ref: 'refs/heads/feature/foo' }), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('skips a push to the default branch', async () => {
    const deps = makeDeps();
    // even if it somehow matched ticket-, never PR the base into itself
    expect(await handlePushEvent(push({ ref: 'refs/heads/main' }), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('skips when the repo is not linked to any project', async () => {
    const deps = makeDeps({ findByOwnerRepo: vi.fn().mockResolvedValue([]) });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('skips when no task matches the branch shortId', async () => {
    const deps = makeDeps({ resolveTaskCandidates: vi.fn().mockResolvedValue([]) });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('skips an ambiguous match (more than one task on repo-linked servers)', async () => {
    const deps = makeDeps({
      resolveTaskCandidates: vi.fn().mockResolvedValue([
        { serverId: 'ws_1', channelId: null, taskId: 'task_1', title: 'A', legacyWorkspaceTodoId: null, createdAt: 1 },
        { serverId: 'ws_1', channelId: null, taskId: 'task_2', title: 'B', legacyWorkspaceTodoId: null, createdAt: 2 },
      ]),
    });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('skips (idempotent) when the branch push was already recorded', async () => {
    const deps = makeDeps({
      listActivity: vi.fn().mockResolvedValue([
        { id: 'act_1', type: 'branch_pushed', metadata: { branch: 'session/job_x/ticket-abcd1234' } },
      ]),
    });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('returns error (and never throws) when branch recording fails', async () => {
    const deps = makeDeps({
      addActivity: vi.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(handlePushEvent(push(), deps)).resolves.toBe('error');
  });

  it('skips while an OPEN PR is still linked to the branch', async () => {
    const deps = makeDeps({
      listActivity: vi.fn().mockResolvedValue([
        { id: 'act_pr', type: 'pr_linked', metadata: { number: 5, state: 'open', repoBranch: 'session/job_x/ticket-abcd1234' } },
      ]),
    });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
  });

  it('records a re-push after the branch\'s PR was merged (terminal PRs do not block continued work)', async () => {
    const deps = makeDeps({
      listActivity: vi.fn().mockResolvedValue([
        { id: 'act_pr', type: 'pr_linked', metadata: { number: 5, state: 'merged', repoBranch: 'session/job_x/ticket-abcd1234' } },
      ]),
    });
    expect(await handlePushEvent(push(), deps)).toBe('recorded');
    expect(deps.addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({
      type: 'branch_pushed',
    }));
  });

  it('opens a draft PR after recording branch_pushed for a useWorktree task', async () => {
    // Use a stateful activities list so openPullRequestForReadyTask can read the
    // branch_pushed entry that handlePushEvent just recorded via addActivity.
    const activities: any[] = [];
    const listActivity = vi.fn().mockImplementation(async () => [...activities]);
    const addActivity = vi.fn().mockImplementation(async (_: string, __: string, input: any) => {
      activities.push({ id: `act_${activities.length}`, type: input.type, metadata: input.metadata ?? null });
    });
    const createPullRequest = vi.fn().mockResolvedValue({ number: 7, url: 'u', headRef: 'session/job_x/ticket-abcd1234', nodeId: 'PR_node' });
    const deps = makeDeps({
      getTask: vi.fn().mockResolvedValue({ useWorktree: true }),
      listActivity,
      addActivity,
      createPullRequest,
      findOpenPullRequestByHead: vi.fn().mockResolvedValue(null),
    });
    const result = await handlePushEvent(push(), deps);
    expect(result).toBe('recorded');
    // allow the fire-and-forget draft open to settle
    await new Promise((r) => setImmediate(r));
    expect(createPullRequest).toHaveBeenCalledWith(42, 'acme', 'app', expect.objectContaining({ draft: true }));
  });

  it('does NOT open a PR for a non-useWorktree task', async () => {
    const createPullRequest = vi.fn();
    const deps = makeDeps({ getTask: vi.fn().mockResolvedValue({ useWorktree: false }), createPullRequest });
    await handlePushEvent(push(), deps);
    await new Promise((r) => setImmediate(r));
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("returns 'recorded' (and never throws) when the useWorktree lookup fails after the branch was recorded", async () => {
    const addActivity = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      addActivity,
      getTask: vi.fn().mockRejectedValue(new Error('db down')),
    });
    // The branch_pushed activity write succeeded; a transient getTask failure on
    // the fire-and-forget PR path must NOT change the result to 'error'.
    await expect(handlePushEvent(push(), deps)).resolves.toBe('recorded');
    expect(addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({ type: 'branch_pushed' }));
    // flush the fire-and-forget rejection so it is caught (no unhandled rejection)
    await new Promise((r) => setImmediate(r));
  });
});

function makeReadyDeps(over: Partial<ReadyPullRequestDeps> = {}): ReadyPullRequestDeps {
  return {
    listActivity: vi.fn().mockResolvedValue([
      {
        id: 'act_branch',
        type: 'branch_pushed',
        metadata: {
          shortId: 'abcd1234',
          owner: 'acme',
          repo: 'app',
          branch: 'session/job_x/ticket-abcd1234',
          base: 'main',
          installationId: 42,
          title: 'Add dark mode',
        },
      },
    ]),
    addActivity: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    findOpenPullRequestByHead: vi.fn().mockResolvedValue(null),
    createPullRequest: vi.fn().mockResolvedValue({ number: 7, url: 'https://github.com/acme/app/pull/7', nodeId: 'PR_7_node' }),
    markPullRequestReady: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('openPullRequestForReadyTask', () => {
  it('opens and links a PR from the recorded branch', async () => {
    const deps = makeReadyDeps();
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result).toEqual({ status: 'opened', prNumber: 7, url: 'https://github.com/acme/app/pull/7' });
    expect(deps.createPullRequest).toHaveBeenCalledWith(42, 'acme', 'app', expect.objectContaining({
      head: 'session/job_x/ticket-abcd1234',
      base: 'main',
      title: 'Add dark mode',
    }));
    expect(deps.addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({
      type: 'pr_linked',
      metadata: expect.objectContaining({ number: 7, repoBranch: 'session/job_x/ticket-abcd1234' }),
    }));
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'needs_review' });
  });

  it('links an existing open PR instead of creating another one', async () => {
    const deps = makeReadyDeps({
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 3, url: 'https://github.com/acme/app/pull/3', nodeId: 'PR_3_node', isDraft: false }),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result).toEqual({ status: 'marked_ready', prNumber: 3, url: 'https://github.com/acme/app/pull/3' });
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({
      type: 'pr_linked',
      metadata: expect.objectContaining({ number: 3 }),
    }));
  });

  it('skips with an actionable reason when no pushed branch has been recorded', async () => {
    const deps = makeReadyDeps({ listActivity: vi.fn().mockResolvedValue([]) });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result.status).toBe('skipped');
    expect(result).toMatchObject({ reason: expect.stringContaining('No pushed commits') });
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('surfaces the GitHub error message when PR creation fails', async () => {
    const deps = makeReadyDeps({
      createPullRequest: vi.fn().mockRejectedValue(new Error('No commits between main and the branch')),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result).toEqual({ status: 'error', message: 'No commits between main and the branch' });
  });

  it('skips while an OPEN PR is already linked (no duplicate PR) — ready mode bypasses this via findOpenPullRequestByHead', async () => {
    // In ready mode, the hasOpenLinkedPr early-skip is removed; instead the
    // GitHub lookup (findOpenPullRequestByHead) handles idempotency by reusing
    // the existing PR. Simulate: pr_linked recorded but GitHub shows no open PR.
    const deps = makeReadyDeps({
      listActivity: vi.fn().mockResolvedValue([
        {
          id: 'act_branch',
          type: 'branch_pushed',
          metadata: { shortId: 'abcd1234', owner: 'acme', repo: 'app', branch: 'session/job_x/ticket-abcd1234', base: 'main', installationId: 42, title: 'Add dark mode' },
        },
        { id: 'act_pr', type: 'pr_linked', metadata: { number: 9, state: 'open', repoBranch: 'session/job_x/ticket-abcd1234' } },
      ]),
      // GitHub still shows the PR as open — ready mode links it via marked_ready
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 9, url: 'u', nodeId: 'PR_9_node', isDraft: false }),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result.status).toBe('marked_ready');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('opens a fresh PR for continued work after the previous PR was merged', async () => {
    const deps = makeReadyDeps({
      listActivity: vi.fn().mockResolvedValue([
        {
          id: 'act_branch',
          type: 'branch_pushed',
          metadata: { shortId: 'abcd1234', owner: 'acme', repo: 'app', branch: 'session/job_x/ticket-abcd1234', base: 'main', installationId: 42, title: 'Add dark mode' },
        },
        { id: 'act_pr', type: 'pr_linked', metadata: { number: 9, state: 'merged', repoBranch: 'session/job_x/ticket-abcd1234' } },
      ]),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result.status).toBe('opened');
    expect(deps.createPullRequest).toHaveBeenCalledWith(42, 'acme', 'app', expect.objectContaining({
      head: 'session/job_x/ticket-abcd1234',
    }));
  });
});

describe('openPullRequestForReadyTask modes', () => {
  it("mode='draft' creates a draft PR and does NOT set task status", async () => {
    const deps = makeReadyDeps();
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'draft' });
    expect(result.status).toBe('opened');
    expect(deps.createPullRequest).toHaveBeenCalledWith(42, 'acme', 'app', expect.objectContaining({ draft: true }));
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it("mode='draft' is idempotent when an open PR already exists (no second PR)", async () => {
    const deps = makeReadyDeps({
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 5, url: 'u', nodeId: 'PR_5_node', isDraft: true }),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'draft' });
    expect(result.status).toBe('linked_existing');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it("mode='draft' is idempotent when pr_linked already recorded", async () => {
    const deps = makeReadyDeps({
      listActivity: vi.fn().mockResolvedValue([
        { id: 'a', type: 'branch_pushed', metadata: { owner: 'acme', repo: 'app', branch: 'session/job_x/ticket-abcd1234', base: 'main', installationId: 42, title: 'Add dark mode', shortId: 'abcd1234' } },
        { id: 'b', type: 'pr_linked', metadata: { number: 5, state: 'open', repoBranch: 'session/job_x/ticket-abcd1234' } },
      ]),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'draft' });
    expect(result.status).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it("mode='ready' un-drafts an existing draft PR and sets needs_review", async () => {
    const deps = makeReadyDeps({
      listActivity: vi.fn().mockResolvedValue([
        { id: 'a', type: 'branch_pushed', metadata: { owner: 'acme', repo: 'app', branch: 'session/job_x/ticket-abcd1234', base: 'main', installationId: 42, title: 'Add dark mode', shortId: 'abcd1234' } },
        { id: 'b', type: 'pr_linked', metadata: { number: 7, repoBranch: 'session/job_x/ticket-abcd1234' } },
      ]),
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 7, url: 'https://github.com/acme/app/pull/7', nodeId: 'PR_node', isDraft: true }),
      markPullRequestReady: vi.fn().mockResolvedValue(undefined),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'ready' });
    expect(result.status).toBe('marked_ready');
    expect(deps.markPullRequestReady).toHaveBeenCalledWith(42, 'PR_node');
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'needs_review' });
  });

  it("mode='ready' creates a non-draft PR if none exists and sets needs_review", async () => {
    const deps = makeReadyDeps();
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'ready' });
    expect(result.status).toBe('opened');
    expect(deps.createPullRequest).toHaveBeenCalledWith(42, 'acme', 'app', expect.objectContaining({ draft: false }));
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'needs_review' });
    expect(deps.markPullRequestReady).not.toHaveBeenCalled();
  });

  it("mode='ready' does NOT call markPullRequestReady if existing PR is not a draft", async () => {
    const deps = makeReadyDeps({
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 8, url: 'u', nodeId: 'PR_8_node', isDraft: false }),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'ready' });
    expect(result.status).toBe('marked_ready');
    expect(deps.markPullRequestReady).not.toHaveBeenCalled();
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'needs_review' });
  });

  it("createIfMissing:false promotes an existing draft PR (job-done un-draft path)", async () => {
    const deps = makeReadyDeps({
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 9, url: 'u', nodeId: 'PR_9_node', isDraft: true }),
      markPullRequestReady: vi.fn().mockResolvedValue(undefined),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'ready', createIfMissing: false });
    expect(result.status).toBe('marked_ready');
    expect(deps.markPullRequestReady).toHaveBeenCalledWith(42, 'PR_9_node');
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'needs_review' });
  });

  it("createIfMissing:false does NOT open a PR when none exists (no PR from heuristic done)", async () => {
    const deps = makeReadyDeps(); // findOpenPullRequestByHead defaults to null
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps, { mode: 'ready', createIfMissing: false });
    expect(result.status).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });
});
