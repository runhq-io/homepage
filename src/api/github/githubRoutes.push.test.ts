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
    createPullRequest: vi.fn().mockResolvedValue({ number: 7, url: 'https://github.com/acme/app/pull/7' }),
    ...over,
  };
}

describe('openPullRequestForReadyTask', () => {
  it('opens and links a PR from the recorded branch', async () => {
    const deps = makeReadyDeps();
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result).toBe('opened');
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
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 3, url: 'https://github.com/acme/app/pull/3' }),
    });
    const result = await openPullRequestForReadyTask('ws_1', 'task_1', deps);
    expect(result).toBe('linked_existing');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({
      type: 'pr_linked',
      metadata: expect.objectContaining({ number: 3 }),
    }));
  });

  it('skips when no pushed branch has been recorded', async () => {
    const deps = makeReadyDeps({ listActivity: vi.fn().mockResolvedValue([]) });
    expect(await openPullRequestForReadyTask('ws_1', 'task_1', deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips while an OPEN PR is already linked (no duplicate PR)', async () => {
    const deps = makeReadyDeps({
      listActivity: vi.fn().mockResolvedValue([
        {
          id: 'act_branch',
          type: 'branch_pushed',
          metadata: { shortId: 'abcd1234', owner: 'acme', repo: 'app', branch: 'session/job_x/ticket-abcd1234', base: 'main', installationId: 42, title: 'Add dark mode' },
        },
        { id: 'act_pr', type: 'pr_linked', metadata: { number: 9, state: 'open', repoBranch: 'session/job_x/ticket-abcd1234' } },
      ]),
    });
    expect(await openPullRequestForReadyTask('ws_1', 'task_1', deps)).toBe('skipped');
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
    expect(await openPullRequestForReadyTask('ws_1', 'task_1', deps)).toBe('opened');
    expect(deps.createPullRequest).toHaveBeenCalledWith(42, 'acme', 'app', expect.objectContaining({
      head: 'session/job_x/ticket-abcd1234',
    }));
  });
});
