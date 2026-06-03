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
