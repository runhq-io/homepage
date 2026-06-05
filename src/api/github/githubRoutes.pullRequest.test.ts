/**
 * Unit tests for the pull_request webhook handler.
 *
 * All dependencies are mocked — no DB needed. The real-DB integration
 * path is covered in githubRoutes.pullRequest.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';

import {
  extractTicketShortId,
  handlePullRequestEvent,
  registerGithubRoutes,
  type PrLinkedDeps,
  type PullRequestPayload,
  type GithubRoutesDeps,
} from './githubRoutes.js';
import { signInstallState } from './installState.js';

// ---------------------------------------------------------------------------
// extractTicketShortId
// ---------------------------------------------------------------------------

describe('extractTicketShortId', () => {
  it('extracts shortId from session/<jobId>/ticket-<shortId> branch', () => {
    expect(extractTicketShortId('session/job1/ticket-abcd1234')).toBe('abcd1234');
  });

  it('extracts from a bare ticket-<shortId> branch', () => {
    expect(extractTicketShortId('ticket-cafe1234')).toBe('cafe1234');
  });

  it('is case-insensitive (normalises to lowercase)', () => {
    expect(extractTicketShortId('session/x/ticket-ABCD1234')).toBe('abcd1234');
  });

  it('returns null for a branch with no ticket- fragment', () => {
    expect(extractTicketShortId('feat/my-feature')).toBeNull();
    expect(extractTicketShortId('session/job1/nope')).toBeNull();
    expect(extractTicketShortId('')).toBeNull();
  });

  it('accepts the 32-char maximum hex shortId', () => {
    const id32 = 'a'.repeat(32);
    expect(extractTicketShortId(`ticket-${id32}`)).toBe(id32);
  });
});

// ---------------------------------------------------------------------------
// handlePullRequestEvent — pure unit tests (no DB)
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<PrLinkedDeps> = {}): PrLinkedDeps {
  return {
    findByOwnerRepo: vi.fn(async () => [{ serverId: 'ws_a', projectId: 'p1', installationId: 9 }]),
    parseTaskShareId: (input: string) => ({ kind: 'prefix' as const, value: input }),
    resolveTaskCandidates: vi.fn(async () => [{
      serverId: 'ws_a',
      channelId: null,
      taskId: 'abcd1234-0000-4000-a000-000000000000',
      title: 'My ticket',
      legacyWorkspaceTodoId: null,
      createdAt: 1000,
    }]),
    listActivity: vi.fn(async () => []),
    addActivity: vi.fn(async () => {}),
    updateTask: vi.fn(async () => {}),
    ...overrides,
  };
}

function makePayload(overrides: {
  action?: string;
  branch?: string;
  number?: number;
  owner?: string;
  repo?: string;
} = {}): PullRequestPayload {
  return {
    action: overrides.action ?? 'opened',
    pull_request: {
      number: overrides.number ?? 42,
      html_url: `https://github.com/acme/web/pull/${overrides.number ?? 42}`,
      state: 'open',
      merged: false,
      head: { ref: overrides.branch ?? 'session/job1/ticket-abcd1234' },
    },
    repository: {
      name: overrides.repo ?? 'web',
      owner: { login: overrides.owner ?? 'acme' },
    },
  };
}

describe('handlePullRequestEvent', () => {
  describe('action filtering', () => {
    it('returns skipped for action=closed', async () => {
      const deps = makeDeps();
      const result = await handlePullRequestEvent(makePayload({ action: 'closed' }), deps);
      expect(result).toBe('skipped');
      expect(deps.addActivity).not.toHaveBeenCalled();
    });

    it('returns skipped for action=synchronize', async () => {
      const deps = makeDeps();
      const result = await handlePullRequestEvent(makePayload({ action: 'synchronize' }), deps);
      expect(result).toBe('skipped');
    });

    it('processes action=opened', async () => {
      const deps = makeDeps();
      const result = await handlePullRequestEvent(makePayload({ action: 'opened' }), deps);
      expect(result).toBe('linked');
    });

    it('processes action=reopened', async () => {
      const deps = makeDeps();
      const result = await handlePullRequestEvent(makePayload({ action: 'reopened' }), deps);
      expect(result).toBe('linked');
    });
  });

  describe('branch parsing', () => {
    it('returns skipped when branch has no ticket- fragment', async () => {
      const deps = makeDeps();
      const result = await handlePullRequestEvent(makePayload({ branch: 'feat/no-ticket' }), deps);
      expect(result).toBe('skipped');
      expect(deps.findByOwnerRepo).not.toHaveBeenCalled();
    });
  });

  describe('repo mapping', () => {
    it('returns skipped when no repo mapping found', async () => {
      const deps = makeDeps({ findByOwnerRepo: vi.fn(async () => []) });
      const result = await handlePullRequestEvent(makePayload(), deps);
      expect(result).toBe('skipped');
      expect(deps.resolveTaskCandidates).not.toHaveBeenCalled();
    });
  });

  describe('task resolution', () => {
    it('returns skipped when no task matches the shortId', async () => {
      const deps = makeDeps({ resolveTaskCandidates: vi.fn(async () => []) });
      const result = await handlePullRequestEvent(makePayload(), deps);
      expect(result).toBe('skipped');
      expect(deps.addActivity).not.toHaveBeenCalled();
    });

    it('returns skipped when task is on a different server than the repo', async () => {
      const deps = makeDeps({
        findByOwnerRepo: vi.fn(async () => [{ serverId: 'ws_b', projectId: 'p2', installationId: 9 }]),
        resolveTaskCandidates: vi.fn(async () => [{
          serverId: 'ws_a', // different server
          channelId: null,
          taskId: 'abcd1234-0000-4000-a000-000000000000',
          title: 'T',
          legacyWorkspaceTodoId: null,
          createdAt: 1000,
        }]),
      });
      const result = await handlePullRequestEvent(makePayload(), deps);
      expect(result).toBe('skipped');
    });

    it('returns skipped when multiple tasks match on repo-linked servers (ambiguous)', async () => {
      const deps = makeDeps({
        resolveTaskCandidates: vi.fn(async () => [
          { serverId: 'ws_a', channelId: null, taskId: 'aaaa0000-0000-4000-a000-000000000000', title: 'A', legacyWorkspaceTodoId: null, createdAt: 1000 },
          { serverId: 'ws_a', channelId: null, taskId: 'bbbb0000-0000-4000-a000-000000000000', title: 'B', legacyWorkspaceTodoId: null, createdAt: 2000 },
        ]),
      });
      const result = await handlePullRequestEvent(makePayload(), deps);
      expect(result).toBe('skipped');
      expect(deps.addActivity).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('returns skipped when a pr_linked activity for this PR number already exists', async () => {
      const deps = makeDeps({
        listActivity: vi.fn(async () => [
          { type: 'pr_linked' as const, metadata: { number: 42, url: '...', state: 'open', repoBranch: 'x' } },
        ]),
      });
      const result = await handlePullRequestEvent(makePayload({ number: 42 }), deps);
      expect(result).toBe('skipped');
      expect(deps.addActivity).not.toHaveBeenCalled();
      expect(deps.updateTask).not.toHaveBeenCalled();
    });

    it('links when the existing pr_linked activity is for a different PR number', async () => {
      const deps = makeDeps({
        listActivity: vi.fn(async () => [
          { type: 'pr_linked' as const, metadata: { number: 99 } },
        ]),
      });
      const result = await handlePullRequestEvent(makePayload({ number: 42 }), deps);
      expect(result).toBe('linked');
      expect(deps.addActivity).toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('writes a pr_linked activity with the correct metadata', async () => {
      const deps = makeDeps();
      const result = await handlePullRequestEvent(makePayload({ number: 42, branch: 'session/job1/ticket-abcd1234' }), deps);
      expect(result).toBe('linked');

      expect(deps.addActivity).toHaveBeenCalledWith(
        'ws_a',
        'abcd1234-0000-4000-a000-000000000000',
        expect.objectContaining({
          type: 'pr_linked',
          content: 'Pull request #42 opened',
          metadata: expect.objectContaining({
            number: 42,
            state: 'open',
            repoBranch: 'session/job1/ticket-abcd1234',
          }),
          createdByType: 'system',
        }),
      );
    });

    it('sets task status to needs_review', async () => {
      const deps = makeDeps();
      await handlePullRequestEvent(makePayload(), deps);

      expect(deps.updateTask).toHaveBeenCalledWith(
        'ws_a',
        'abcd1234-0000-4000-a000-000000000000',
        { status: 'needs_review' },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Route integration: pull_request via HTTP (signature + dep wiring)
// ---------------------------------------------------------------------------

const cfg = { appId: '1', appSlug: 'runhq', privateKey: 'k', webhookSecret: 'whsec', stateSecret: 'st' };

function makeRouteApp(prLinked: Partial<PrLinkedDeps> = {}) {
  const deps: GithubRoutesDeps = {
    config: cfg,
    clientUrl: 'https://app.runhq.io',
    getServerByToken: async () => null,
    upsertInstallation: vi.fn(async () => {}),
    removeInstallation: vi.fn(async () => {}),
    getInstallation: async () => null,
    associateWithWorkspace: vi.fn(async () => {}),
    isAssociatedWithWorkspace: async () => false,
    mintInstallationToken: async () => ({ token: 'tok', expiresAt: 'soon' }),
    prLinked: makeDeps(prLinked),
  };
  const app = new Hono();
  registerGithubRoutes(app, deps);
  return { app, deps };
}

function signPayload(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('pull_request webhook via HTTP route', () => {
  it('returns 200 and calls the handler for action=opened', async () => {
    const addActivity = vi.fn(async () => {});
    const { app } = makeRouteApp({ addActivity });

    const payload = JSON.stringify(makePayload({ action: 'opened' }));
    const sig = signPayload(payload, cfg.webhookSecret);

    const res = await app.request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(addActivity).toHaveBeenCalledTimes(1);
  });

  it('returns 200 even when the handler throws (error must not propagate)', async () => {
    const { app } = makeRouteApp({
      findByOwnerRepo: vi.fn(async () => { throw new Error('DB exploded'); }),
    });

    const payload = JSON.stringify(makePayload({ action: 'opened' }));
    const sig = signPayload(payload, cfg.webhookSecret);

    const res = await app.request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body: payload,
    });

    expect(res.status).toBe(200);
  });

  it('is a no-op (200) when prLinked deps are absent', async () => {
    const deps: GithubRoutesDeps = {
      config: cfg,
      clientUrl: 'https://app.runhq.io',
      getServerByToken: async () => null,
      upsertInstallation: vi.fn(async () => {}),
      removeInstallation: vi.fn(async () => {}),
      getInstallation: async () => null,
      associateWithWorkspace: vi.fn(async () => {}),
      isAssociatedWithWorkspace: async () => false,
      mintInstallationToken: async () => ({ token: 'tok', expiresAt: 'soon' }),
      // prLinked intentionally absent
    };
    const app = new Hono();
    registerGithubRoutes(app, deps);

    const payload = JSON.stringify(makePayload({ action: 'opened' }));
    const sig = signPayload(payload, cfg.webhookSecret);

    const res = await app.request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body: payload,
    });

    expect(res.status).toBe(200);
  });

  it('returns 401 for a bad signature even on pull_request event', async () => {
    const { app } = makeRouteApp();

    const payload = JSON.stringify(makePayload());
    const res = await app.request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=bad', 'content-type': 'application/json' },
      body: payload,
    });

    expect(res.status).toBe(401);
  });
});
