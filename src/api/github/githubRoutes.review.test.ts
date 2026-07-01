import { describe, it, expect, vi } from 'vitest';
import {
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  type PrLinkedDeps,
  type PullRequestPayload,
  type PullRequestReviewPayload,
} from './githubRoutes';

const REPO = { name: 'app', owner: { login: 'acme' } };
const BRANCH = 'session/job_x/ticket-abcd1234';

function makeDeps(over: Partial<PrLinkedDeps> = {}): PrLinkedDeps {
  return {
    findByOwnerRepo: vi.fn().mockResolvedValue([{ serverId: 'ws_1', projectId: 'p_1', installationId: 42 }]),
    parseTaskShareId: vi.fn().mockReturnValue({ kind: 'shortId', value: 'abcd1234' }),
    resolveTaskCandidates: vi.fn().mockResolvedValue([
      { serverId: 'ws_1', channelId: null, taskId: 'task_1', title: 'Add dark mode', legacyWorkspaceTodoId: null, createdAt: 1 },
    ]),
    listActivity: vi.fn().mockResolvedValue([]),
    addActivity: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    updateActivityMetadata: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ status: 'in_progress' }),
    ...over,
  };
}

const pr = (over: Partial<PullRequestPayload['pull_request']> = {}): PullRequestPayload['pull_request'] => ({
  number: 7,
  html_url: 'https://github.com/acme/app/pull/7',
  state: 'open',
  merged: false,
  head: { ref: BRANCH },
  ...over,
});

const prEvent = (action: string, over: Partial<PullRequestPayload['pull_request']> = {}): PullRequestPayload => ({
  action,
  pull_request: pr(over),
  repository: REPO,
});

const reviewEvent = (
  action: string,
  state: string,
  overPr: Partial<PullRequestPayload['pull_request']> = {},
): PullRequestReviewPayload => ({
  action,
  review: { state, user: { login: 'reviewer-jane' } },
  pull_request: pr(overPr),
  repository: REPO,
});

describe('handlePullRequestEvent — opened', () => {
  it('links the PR and advances the task → done', async () => {
    const deps = makeDeps();
    const result = await handlePullRequestEvent(prEvent('opened'), deps);
    expect(result).toBe('linked');
    expect(deps.addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({ type: 'pr_linked' }));
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'done' });
  });

  it('does not downgrade a task already past done when the PR is (re)opened', async () => {
    const deps = makeDeps({ getTask: vi.fn().mockResolvedValue({ status: 'deployed:prod' }) });
    const result = await handlePullRequestEvent(prEvent('opened'), deps);
    expect(result).toBe('linked'); // activity still written
    expect(deps.updateTask).not.toHaveBeenCalled();
  });
});

describe('handlePullRequestEvent — closed/merged', () => {
  const linked = [{ id: 'act_pr', type: 'pr_linked' as const, metadata: { number: 7, state: 'open', repoBranch: BRANCH } }];

  it('advances a merged PR\'s task → merged', async () => {
    const deps = makeDeps({ listActivity: vi.fn().mockResolvedValue(linked), getTask: vi.fn().mockResolvedValue({ status: 'reviewed' }) });
    const result = await handlePullRequestEvent(prEvent('closed', { merged: true, state: 'closed' }), deps);
    expect(result).toBe('updated');
    expect(deps.updateActivityMetadata).toHaveBeenCalledWith('act_pr', expect.objectContaining({ state: 'merged' }));
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'merged' });
  });

  it('does NOT downgrade a task already deployed when a merged webhook arrives', async () => {
    const deps = makeDeps({ listActivity: vi.fn().mockResolvedValue(linked), getTask: vi.fn().mockResolvedValue({ status: 'deployed:prod' }) });
    const result = await handlePullRequestEvent(prEvent('closed', { merged: true, state: 'closed' }), deps);
    expect(result).toBe('updated');
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it('does not set merged when the PR was closed without merging', async () => {
    const deps = makeDeps({ listActivity: vi.fn().mockResolvedValue(linked) });
    const result = await handlePullRequestEvent(prEvent('closed', { merged: false, state: 'closed' }), deps);
    expect(result).toBe('updated');
    expect(deps.updateActivityMetadata).toHaveBeenCalledWith('act_pr', expect.objectContaining({ state: 'closed' }));
    expect(deps.updateTask).not.toHaveBeenCalled();
  });
});

describe('handlePullRequestReviewEvent', () => {
  it('advances the task → reviewed + writes a pr_reviewed activity on approval', async () => {
    const deps = makeDeps({ getTask: vi.fn().mockResolvedValue({ status: 'done' }) });
    const result = await handlePullRequestReviewEvent(reviewEvent('submitted', 'approved'), deps);
    expect(result).toBe('reviewed');
    expect(deps.addActivity).toHaveBeenCalledWith('ws_1', 'task_1', expect.objectContaining({
      type: 'pr_reviewed',
      content: 'Pull request #7 approved',
      metadata: expect.objectContaining({ number: 7, reviewer: 'reviewer-jane' }),
    }));
    expect(deps.updateTask).toHaveBeenCalledWith('ws_1', 'task_1', { status: 'reviewed' });
  });

  it('pushes a workspace notify (state open) so the live status pill resyncs to reviewed', async () => {
    const notifyPrLinked = vi.fn(async () => {});
    const deps = makeDeps({ getTask: vi.fn().mockResolvedValue({ status: 'done' }), notifyPrLinked });
    await handlePullRequestReviewEvent(reviewEvent('submitted', 'approved'), deps);
    expect(notifyPrLinked).toHaveBeenCalledWith('ws_1', expect.objectContaining({ branch: BRANCH, number: 7, state: 'open' }));
  });

  it('does NOT push a workspace notify when the approval is a no-op (already merged)', async () => {
    const notifyPrLinked = vi.fn(async () => {});
    const deps = makeDeps({ getTask: vi.fn().mockResolvedValue({ status: 'merged' }), notifyPrLinked });
    await handlePullRequestReviewEvent(reviewEvent('submitted', 'approved'), deps);
    expect(notifyPrLinked).not.toHaveBeenCalled();
  });

  it('accepts an upper-cased APPROVED state (GitHub casing tolerance)', async () => {
    const deps = makeDeps({ getTask: vi.fn().mockResolvedValue({ status: 'done' }) });
    expect(await handlePullRequestReviewEvent(reviewEvent('submitted', 'APPROVED'), deps)).toBe('reviewed');
  });

  it('is a no-op for non-approval review states', async () => {
    const deps = makeDeps();
    expect(await handlePullRequestReviewEvent(reviewEvent('submitted', 'changes_requested'), deps)).toBe('skipped');
    expect(await handlePullRequestReviewEvent(reviewEvent('submitted', 'commented'), deps)).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it('is a no-op for non-submitted actions (edited/dismissed)', async () => {
    const deps = makeDeps();
    expect(await handlePullRequestReviewEvent(reviewEvent('edited', 'approved'), deps)).toBe('skipped');
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it('does NOT downgrade a task already merged when an approval arrives late', async () => {
    const deps = makeDeps({ getTask: vi.fn().mockResolvedValue({ status: 'merged' }) });
    const result = await handlePullRequestReviewEvent(reviewEvent('submitted', 'approved'), deps);
    expect(result).toBe('skipped');
    expect(deps.addActivity).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it('skips when the branch resolves to no task', async () => {
    const deps = makeDeps({ resolveTaskCandidates: vi.fn().mockResolvedValue([]) });
    expect(await handlePullRequestReviewEvent(reviewEvent('submitted', 'approved'), deps)).toBe('skipped');
    expect(deps.updateTask).not.toHaveBeenCalled();
  });
});
