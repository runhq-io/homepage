# CLAUDE.md

## Deployment

Static site deployed to Cloudflare Pages. Do NOT deploy unless the user explicitly instructs you to do so.

### Environment map — check this before every deploy

| Env | Domain | CF Pages project | npm script | Auto-deploy on push? |
|---|---|---|---|---|
| Staging | `staging.runhq.io` | `runhq-homepage-staging` | `npm run deploy:staging` | **Yes** (`.github/workflows/deploy-staging.yml`) |
| Production | `www.runhq.io` | `fishtank-homepage` | `npm run deploy:production` | **No** — `workflow_dispatch` only (`.github/workflows/deploy-production.yml`) |

The CF project name and the npm script must match the env. `runhq-homepage-staging` is staging; `fishtank-homepage` is production. Do not edit these without also updating this table.

### Pushing to `main` only updates staging

Production is a separate manual step. A commit on `main` does **not** land on `www.runhq.io` until someone fires the production deploy. If you forget, prod silently drifts behind staging.

**After any homepage change lands on `main`, the deployer must:**
1. Confirm staging updated (auto-deploy via GH Actions, or `npm run deploy:staging`).
2. Manually trigger production — either the `Deploy to Production` workflow on GitHub Actions, or `npm run deploy:production` locally.
3. Verify both domains are serving the new commit before declaring "deployed."

### Verifying what's actually live

Bundle hash differences between staging and prod are expected (different `VITE_API_URL` bakes into the build). To confirm which commit each env is serving, query the Cloudflare API:

```bash
set -a && source .env && set +a
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/<project>/deployments?per_page=3" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
```

Replace `<project>` with `runhq-homepage-staging` or `fishtank-homepage`. The `deployment_trigger.metadata.commit_hash` field tells you exactly which commit is live.

### Local deploys: mind the `VITE_API_URL`

The GitHub Actions workflows set `VITE_API_URL` explicitly per env (`console-staging.runhq.io` for staging, `console.runhq.io` for prod). The npm scripts do **not** — they rely on the source default (`https://console.runhq.io`).

- `npm run deploy:production` locally: safe, defaults match prod.
- `npm run deploy:staging` locally: **will ship a staging site that hits the prod API** unless you prefix `VITE_API_URL=https://console-staging.runhq.io`. Prefer the GH Actions auto-deploy for staging.

The same applies to `VITE_GA_ID` and `VITE_RUNHQ_ENV` (which environment RunHQ's
own telemetry reports as). A local staging deploy needs all three or it reports
into production:

```bash
VITE_API_URL=https://console-staging.runhq.io VITE_GA_ID=none VITE_RUNHQ_ENV=staging npm run deploy:staging
```

### Cloudflare credentials

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live in `.env`. Source it (`set -a && source .env && set +a`) before running `wrangler` or the Cloudflare API directly.
