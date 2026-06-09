import { describe, it, expect, vi } from 'vitest';
import { handlePushEvent, type PushEventDeps, type PushPayload } from './githubRoutes';

const REPO = { name: 'app', owner: { login: 'acme' }, default_branch: 'main' };

function makeDeps(over: Partial<PushEventDeps> = {}): PushEventDeps {
  return {
    findByOwnerRepo: vi.fn().mockResolvedValue([{ serverId: 'ws_1', projectId: 'p_1', installationId: 42 }]),
    parseTaskShareId: vi.fn().mockReturnValue({ kind: 'shortId', value: 'abcd1234' }),
    resolveTaskCandidates: vi.fn().mockResolvedValue([
      { serverId: 'ws_1', channelId: null, taskId: 'task_1', title: 'Add dark mode', legacyWorkspaceTodoId: null, createdAt: 1 },
    ]),
    findOpenPullRequestByHead: vi.fn().mockResolvedValue(null),
    createPullRequest: vi.fn().mockResolvedValue({ number: 7, url: 'https://github.com/acme/app/pull/7', headRef: 'ticket-abcd1234' }),
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
  it('opens a PR for a ticket branch with no existing PR', async () => {
    const deps = makeDeps();
    const result = await handlePushEvent(push(), deps);
    expect(result).toBe('created');
    expect(deps.createPullRequest).toHaveBeenCalledWith(42, 'acme', 'app', expect.objectContaining({
      head: 'session/job_x/ticket-abcd1234',
      base: 'main',
      title: 'Add dark mode',
    }));
  });

  it('skips a non-branch ref (tag push)', async () => {
    const deps = makeDeps();
    expect(await handlePushEvent(push({ ref: 'refs/tags/v1' }), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips a branch deletion', async () => {
    const deps = makeDeps();
    expect(await handlePushEvent(push({ deleted: true }), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips a non-ticket branch', async () => {
    const deps = makeDeps();
    expect(await handlePushEvent(push({ ref: 'refs/heads/feature/foo' }), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips a push to the default branch', async () => {
    const deps = makeDeps();
    // even if it somehow matched ticket-, never PR the base into itself
    expect(await handlePushEvent(push({ ref: 'refs/heads/main' }), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips when the repo is not linked to any project', async () => {
    const deps = makeDeps({ findByOwnerRepo: vi.fn().mockResolvedValue([]) });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips when no task matches the branch shortId', async () => {
    const deps = makeDeps({ resolveTaskCandidates: vi.fn().mockResolvedValue([]) });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips an ambiguous match (more than one task on repo-linked servers)', async () => {
    const deps = makeDeps({
      resolveTaskCandidates: vi.fn().mockResolvedValue([
        { serverId: 'ws_1', channelId: null, taskId: 'task_1', title: 'A', legacyWorkspaceTodoId: null, createdAt: 1 },
        { serverId: 'ws_1', channelId: null, taskId: 'task_2', title: 'B', legacyWorkspaceTodoId: null, createdAt: 2 },
      ]),
    });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips (idempotent) when an open PR already exists for the branch', async () => {
    const deps = makeDeps({
      findOpenPullRequestByHead: vi.fn().mockResolvedValue({ number: 3, url: 'u' }),
    });
    expect(await handlePushEvent(push(), deps)).toBe('skipped');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  it('returns error (and never throws) when PR creation fails (e.g. no commits / 422)', async () => {
    const deps = makeDeps({
      createPullRequest: vi.fn().mockRejectedValue(Object.assign(new Error('Validation Failed'), { status: 422 })),
    });
    await expect(handlePushEvent(push(), deps)).resolves.toBe('error');
  });
});
