import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { getGithubAppConfig } from '../github/config.js';

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface InstallationRepo {
  name: string;
  full_name: string;
  owner: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
}

interface OctokitLike {
  paginate(route: string, params?: Record<string, unknown>): Promise<any[]>;
  request(route: string, params?: Record<string, unknown>): Promise<{ data: any }>;
}

export interface GitHubAppDeps {
  auth?: (opts: { type: 'installation'; installationId: number }) => Promise<InstallationToken>;
  makeOctokit?: (token: string) => OctokitLike;
}

export class GitHubAppService {
  private auth: NonNullable<GitHubAppDeps['auth']>;
  private makeOctokit: NonNullable<GitHubAppDeps['makeOctokit']>;

  constructor(deps: GitHubAppDeps = {}) {
    if (deps.auth) {
      this.auth = deps.auth;
    } else {
      const cfg = getGithubAppConfig();
      const appAuth = createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey });
      this.auth = (opts) => appAuth(opts) as Promise<InstallationToken>;
    }
    this.makeOctokit = deps.makeOctokit ?? ((token: string) => new Octokit({ auth: token }) as unknown as OctokitLike);
  }

  async mintInstallationToken(installationId: number): Promise<InstallationToken> {
    const { token, expiresAt } = await this.auth({ type: 'installation', installationId });
    return { token, expiresAt };
  }

  private async octokitFor(installationId: number): Promise<OctokitLike> {
    const { token } = await this.mintInstallationToken(installationId);
    return this.makeOctokit(token);
  }

  async listInstallationRepos(installationId: number): Promise<InstallationRepo[]> {
    const okit = await this.octokitFor(installationId);
    const repos = await okit.paginate('GET /installation/repositories', { per_page: 100 });
    return repos.map((r: any) => ({
      name: r.name,
      full_name: r.full_name,
      owner: r.owner?.login,
      clone_url: r.clone_url,
      default_branch: r.default_branch,
      private: !!r.private,
    }));
  }

  async listPullRequests(installationId: number, owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open') {
    const okit = await this.octokitFor(installationId);
    const prs = await okit.paginate('GET /repos/{owner}/{repo}/pulls', { owner, repo, state, per_page: 50 });
    return prs.map((p: any) => ({
      number: p.number,
      title: p.title,
      state: (p.merged_at ? 'merged' : p.state) as 'open' | 'closed' | 'merged',
      isDraft: !!p.draft,
      author: p.user?.login ?? '',
      headRef: p.head?.ref ?? '',
      baseRef: p.base?.ref ?? '',
      url: p.html_url,
    }));
  }

  async getPullRequestDiff(installationId: number, owner: string, repo: string, pull_number: number) {
    const okit = await this.octokitFor(installationId);
    const files = await okit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { owner, repo, pull_number, per_page: 100 });
    return {
      sha: String(pull_number),
      files: files.map((f: any) => ({ path: f.filename, added: f.additions ?? null, deleted: f.deletions ?? null })),
      patch: files.map((f: any) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch ?? ''}`).join('\n\n'),
    };
  }

  async mergePullRequest(installationId: number, owner: string, repo: string, pull_number: number, merge_method: 'merge' | 'squash' | 'rebase' = 'merge') {
    const okit = await this.octokitFor(installationId);
    const { data } = await okit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { owner, repo, pull_number, merge_method });
    return { merged: !!data.merged, message: data.message ?? '' };
  }

  async createOrgRepo(installationId: number, org: string, name: string, isPrivate: boolean): Promise<InstallationRepo> {
    const okit = await this.octokitFor(installationId);
    const { data } = await okit.request('POST /orgs/{org}/repos', { org, name, private: isPrivate });
    return {
      name: data.name ?? name,
      full_name: data.full_name,
      owner: org,
      clone_url: data.clone_url,
      default_branch: data.default_branch ?? 'main',
      private: !!data.private,
    };
  }
}

let singleton: GitHubAppService | null = null;
export function getGitHubAppService(): GitHubAppService {
  if (!singleton) singleton = new GitHubAppService();
  return singleton;
}
