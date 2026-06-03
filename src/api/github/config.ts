export interface GithubAppConfig {
  appId: string;
  appSlug: string;
  privateKey: string;
  webhookSecret: string;
  stateSecret: string;
}

/** Reads + validates GitHub App env. Throws if a required var is missing. */
export function getGithubAppConfig(): GithubAppConfig {
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  const stateSecret = process.env.GITHUB_APP_STATE_SECRET;
  if (!appId || !appSlug || !privateKey || !webhookSecret || !stateSecret) {
    throw new Error('GitHub App env not configured (GITHUB_APP_ID/SLUG/PRIVATE_KEY/WEBHOOK_SECRET/STATE_SECRET)');
  }
  return { appId, appSlug, privateKey, webhookSecret, stateSecret };
}

/** True when the GitHub App is configured — used to gate the feature without throwing. */
export function isGithubAppConfigured(): boolean {
  return !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_WEBHOOK_SECRET);
}
