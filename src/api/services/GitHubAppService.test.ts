import { describe, it, expect, vi } from 'vitest';
import { GitHubAppService } from './GitHubAppService.js';

function makeService(opts?: { repos?: any[] }) {
  const auth = vi.fn(async ({ installationId }: any) => ({
    token: `tok_${installationId}`,
    expiresAt: '2026-01-01T00:00:00Z',
  }));
  const requests: any[] = [];
  const makeOctokit = (token: string) => ({
    token,
    paginate: vi.fn(async () => opts?.repos ?? []),
    request: vi.fn(async (route: string, params: any) => {
      requests.push({ route, params, token });
      return { data: { full_name: `${params.org}/${params.name}`, clone_url: `https://github.com/${params.org}/${params.name}.git`, default_branch: 'main' } };
    }),
  });
  return { svc: new GitHubAppService({ auth: auth as any, makeOctokit: makeOctokit as any }), auth, requests };
}

describe('GitHubAppService', () => {
  it('mints an installation token', async () => {
    const { svc, auth } = makeService();
    const result = await svc.mintInstallationToken(99);
    expect(result.token).toBe('tok_99');
    expect(auth).toHaveBeenCalledWith({ type: 'installation', installationId: 99 });
  });

  it('lists installation repos via the installation token', async () => {
    const { svc } = makeService({ repos: [{ full_name: 'octo/app', clone_url: 'x', default_branch: 'main', private: true, name: 'app', owner: { login: 'octo' } }] });
    const repos = await svc.listInstallationRepos(99);
    expect(repos).toHaveLength(1);
    expect(repos[0].full_name).toBe('octo/app');
  });

  it('creates an org repo', async () => {
    const { svc, requests } = makeService();
    const repo = await svc.createOrgRepo(99, 'octo', 'newrepo', true);
    expect(repo.full_name).toBe('octo/newrepo');
    expect(requests[0].route).toBe('POST /orgs/{org}/repos');
    expect(requests[0].params).toMatchObject({ org: 'octo', name: 'newrepo', private: true });
    expect(requests[0].token).toBe('tok_99');
  });
});
