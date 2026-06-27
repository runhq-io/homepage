import { describe, it, expect, vi } from 'vitest';
import { GitHubAppService } from './GitHubAppService.js';

function makeService() {
  const auth = vi.fn(async ({ installationId }: any) => ({ token: `tok_${installationId}`, expiresAt: 'x' }));
  const requests: any[] = [];
  const makeOctokit = (token: string) => ({
    token,
    paginate: vi.fn(async (route: string) => {
      if (route.includes('/pulls/') && route.endsWith('/files')) {
        return [{ filename: 'a.ts', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-x\n+y\n+z' }];
      }
      return [{ number: 7, title: 'PR', state: 'open', draft: false, html_url: 'https://gh/7', user: { login: 'octo' }, head: { ref: 'feat' }, base: { ref: 'main' } }];
    }),
    request: vi.fn(async (route: string, params: any) => {
      requests.push({ route, params, token });
      return { data: { merged: true, message: 'Pull Request successfully merged' } };
    }),
  });
  return { svc: new GitHubAppService({ auth: auth as any, makeOctokit: makeOctokit as any }), requests };
}

describe('GitHubAppService pull requests', () => {
  it('lists pull requests', async () => {
    const { svc } = makeService();
    const prs = await svc.listPullRequests(5, 'octo', 'app', 'open');
    expect(prs[0]).toMatchObject({ number: 7, title: 'PR', state: 'open', isDraft: false, author: 'octo', headRef: 'feat', baseRef: 'main', url: 'https://gh/7' });
  });
  it('builds a diff from the files API', async () => {
    const { svc } = makeService();
    const diff = await svc.getPullRequestDiff(5, 'octo', 'app', 7);
    expect(diff.files).toEqual([{ path: 'a.ts', added: 2, deleted: 1 }]);
    expect(diff.patch).toContain('a.ts');
    expect(diff.patch).toContain('+y');
  });
  it('merges a pull request', async () => {
    const { svc, requests } = makeService();
    const result = await svc.mergePullRequest(5, 'octo', 'app', 7, 'squash');
    expect(result.merged).toBe(true);
    expect(requests[0].route).toBe('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge');
    expect(requests[0].params).toMatchObject({ owner: 'octo', repo: 'app', pull_number: 7, merge_method: 'squash' });
    expect(requests[0].token).toBe('tok_5');
  });
});
