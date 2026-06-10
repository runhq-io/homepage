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

export interface InstallationAccount {
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected' | null;
}

interface OctokitLike {
  paginate(route: string, params?: Record<string, unknown>): Promise<any[]>;
  request(route: string, params?: Record<string, unknown>): Promise<{ data: any }>;
}

export interface GitHubAppDeps {
  // Accepts app-JWT auth ({ type: 'app' }) as well as installation auth — the
  // former is needed to read installation metadata (account login/type) before
  // any installation token exists.
  auth?: (opts: { type: 'installation'; installationId: number } | { type: 'app' }) => Promise<InstallationToken>;
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

  /** App-JWT octokit (no installation token) — for App-level endpoints. */
  private async appOctokit(): Promise<OctokitLike> {
    const { token } = await this.auth({ type: 'app' });
    return this.makeOctokit(token);
  }

  /**
   * Authoritative read of an installation's account identity straight from
   * GitHub. Used to populate accountLogin/accountType at install time and to
   * heal rows that were created before the identity was known — so we never
   * depend on the `installation` webhook being delivered to learn who owns it.
   */
  async getInstallationAccount(installationId: number): Promise<InstallationAccount> {
    const okit = await this.appOctokit();
    const { data } = await okit.request('GET /app/installations/{installation_id}', { installation_id: installationId });
    return {
      accountLogin: data.account?.login ?? '',
      accountType: data.account?.type === 'Organization' ? 'Organization' : 'User',
      repositorySelection: (data.repository_selection as 'all' | 'selected' | null) ?? null,
    };
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

  /** Close a pull request without merging (GitHub has no "reject" — closed is the terminal decline state). */
  async closePullRequest(installationId: number, owner: string, repo: string, pull_number: number) {
    const okit = await this.octokitFor(installationId);
    const { data } = await okit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number, state: 'closed' });
    return { closed: data.state === 'closed', message: '' };
  }

  /** Open a pull request from `head` into `base`. Throws on API error (e.g. 422 no-commits). */
  async createPullRequest(
    installationId: number,
    owner: string,
    repo: string,
    args: { title: string; head: string; base: string; body?: string },
  ): Promise<{ number: number; url: string; headRef: string }> {
    const okit = await this.octokitFor(installationId);
    const { data } = await okit.request('POST /repos/{owner}/{repo}/pulls', {
      owner, repo, title: args.title, head: args.head, base: args.base, body: args.body ?? '',
    });
    return { number: data.number, url: data.html_url, headRef: data.head?.ref ?? args.head };
  }

  /** Find an OPEN PR whose head branch is `head`, or null. Used for idempotency before creating one. */
  async findOpenPullRequestByHead(
    installationId: number,
    owner: string,
    repo: string,
    head: string,
  ): Promise<{ number: number; url: string } | null> {
    const prs = await this.listPullRequests(installationId, owner, repo, 'open');
    const match = prs.find((p) => p.headRef === head);
    return match ? { number: match.number, url: match.url } : null;
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
