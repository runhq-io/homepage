import { describe, it, expect, vi } from 'vitest';
import { aggregateForUser, type AggregatePull } from './GithubAggregationService.js';
import type { ProjectRepoLink } from './GithubProjectReposService.js';

const pull = (n: number): AggregatePull => ({
  number: n, title: `PR ${n}`, state: 'open', isDraft: false,
  author: 'octo', headRef: 'feat', baseRef: 'main', url: `https://gh/pr/${n}`,
});

describe('aggregateForUser', () => {
  it('annotates PRs with server/project and de-duplicates repos', async () => {
    const links: ProjectRepoLink[] = [
      { serverId: 's1', projectId: 'p1', installationId: 1, owner: 'acme', repo: 'web', projectName: 'Web' },
      // duplicate repo (same install+owner+repo) — must be fetched only once
      { serverId: 's1', projectId: 'p1b', installationId: 1, owner: 'acme', repo: 'web', projectName: 'Web2' },
      { serverId: 's2', projectId: 'p2', installationId: 2, owner: 'acme', repo: 'api', projectName: 'API' },
    ];
    const listPullRequests = vi.fn(async (_i: number, _o: string, repo: string) =>
      repo === 'web' ? [pull(1)] : [pull(2)],
    );

    const out = await aggregateForUser('u1', { listForUser: async () => links, listPullRequests });

    expect(listPullRequests).toHaveBeenCalledTimes(2); // deduped
    expect(out).toHaveLength(2);
    const web = out.find((p) => p.repo === 'web')!;
    expect(web.serverId).toBe('s1');
    expect(web.projectName).toBe('Web');
    expect(web.url).toBe('https://gh/pr/1');
    const api = out.find((p) => p.repo === 'api')!;
    expect(api.projectId).toBe('p2');
  });

  it('skips a repo whose fetch throws, without failing the whole result', async () => {
    const links: ProjectRepoLink[] = [
      { serverId: 's1', projectId: 'p1', installationId: 1, owner: 'acme', repo: 'good', projectName: 'Good' },
      { serverId: 's1', projectId: 'p2', installationId: 1, owner: 'acme', repo: 'bad', projectName: 'Bad' },
    ];
    const listPullRequests = vi.fn(async (_i: number, _o: string, repo: string) => {
      if (repo === 'bad') throw new Error('410 Gone');
      return [pull(7)];
    });
    const log = vi.fn();

    const out = await aggregateForUser('u1', { listForUser: async () => links, listPullRequests, log });

    expect(out).toHaveLength(1);
    expect(out[0].repo).toBe('good');
    expect(log).toHaveBeenCalled();
  });

  it('returns empty when the user has no linked repos', async () => {
    const out = await aggregateForUser('u1', { listForUser: async () => [], listPullRequests: vi.fn() });
    expect(out).toEqual([]);
  });
});
