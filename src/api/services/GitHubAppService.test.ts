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

  it('reads an installation account via an app-JWT octokit (no installation token)', async () => {
    const auth = vi.fn(async (opts: any) => ({ token: opts.type === 'app' ? 'app_jwt' : `tok_${opts.installationId}`, expiresAt: 'soon' }));
    const makeOctokit = (token: string) => ({
      token,
      paginate: vi.fn(async () => []),
      request: vi.fn(async (route: string, params: any) => {
        expect(route).toBe('GET /app/installations/{installation_id}');
        expect(params).toMatchObject({ installation_id: 42 });
        return { data: { account: { login: 'pranshu6', type: 'Organization' }, repository_selection: 'selected' } };
      }),
    });
    const svc = new GitHubAppService({ auth: auth as any, makeOctokit: makeOctokit as any });
    const account = await svc.getInstallationAccount(42);
    expect(account).toEqual({ accountLogin: 'pranshu6', accountType: 'Organization', repositorySelection: 'selected' });
    expect(auth).toHaveBeenCalledWith({ type: 'app' });
  });

  it('falls back to an empty login / User type when GitHub omits the account', async () => {
    const auth = vi.fn(async () => ({ token: 'app_jwt', expiresAt: 'soon' }));
    const makeOctokit = (_token: string) => ({
      token: _token,
      paginate: vi.fn(async () => []),
      request: vi.fn(async () => ({ data: { repository_selection: null } })),
    });
    const svc = new GitHubAppService({ auth: auth as any, makeOctokit: makeOctokit as any });
    expect(await svc.getInstallationAccount(7)).toEqual({ accountLogin: '', accountType: 'User', repositorySelection: null });
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
