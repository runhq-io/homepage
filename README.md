> [!IMPORTANT]
> **This repo has MOVED (2026-07-02).** It was merged — with full history — into the
> [`runhq-io/runhq-cloud`](https://github.com/runhq-io/runhq-cloud) monorepo at **`be/`**.
> Digital Ocean staging + production now build from `runhq-cloud` (`source_dir: /be`);
> **pushes here deploy NOTHING and will silently diverge.** Make all changes in the
> monorepo. Cutover runbook: `docs/monorepo-migration.md` in runhq-cloud.

# RunHQ Backend

Unified API + admin dashboard for RunHQ — a platform for managing remote servers, AI agents, and team collaboration.

## Tech Stack

- **Runtime:** Node.js 22, TypeScript
- **API:** [Hono](https://hono.dev) (REST + WebSocket)
- **Frontend:** [Next.js](https://nextjs.org) 16 (SSR admin dashboard)
- **Database:** PostgreSQL with [Drizzle ORM](https://orm.drizzle.team)
- **Auth:** JWT + OAuth (Google, GitHub) + device flow
- **Billing:** Stripe subscriptions + credit-based usage
- **Infrastructure:** Fly.io (remote server provisioning), Cloudflare (DNS/tunnels)
- **AI:** Claude API for analysis and tool use
- **Real-time:** WebSocket for task streaming and desktop client communication

## Architecture

A single Node.js process serves everything on one port:

- **Hono** handles `/api/*`, `/health`, `/billing/*`
- **Next.js** handles SSR pages (`/admin/*`, `/login`, `/auth/*`, dashboard)
- **WebSocket** handles real-time connections at `/ws`

## Getting Started

```bash
pnpm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET at minimum
pnpm db:push           # sync schema to database
pnpm db:seed           # seed initial data
pnpm dev               # start dev server with hot reload
```

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start dev server with hot reload |
| `pnpm build` | Build for production (protocol + Next.js + server) |
| `pnpm start` | Run production build |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm db:push` | Push schema changes to database |
| `pnpm db:generate` | Generate migration files |
| `pnpm db:migrate` | Run migrations |
| `pnpm db:seed` | Seed database |
| `pnpm db:studio` | Open Drizzle Studio |

## Environment Variables

For local dev, only these are required:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing key |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | NextAuth secrets |

See [`.env.example`](.env.example) for the full list including Stripe, Fly.io, Cloudflare, and other integrations.

## Project Structure

```
src/
├── app/            # Next.js pages (admin dashboard, auth)
├── api/            # Hono API routes + WebSocket server
│   ├── routes/     # API endpoint handlers
│   └── services/   # Business logic (billing, servers, agents, etc.)
├── db/             # Drizzle schema, migrations, seed
├── components/     # Shared React components
└── server.ts       # Unified server entry point
packages/
└── protocol/       # @runhq/server-protocol — shared WebSocket message types
```

## Deployment

```bash
docker build -t runhq-be .
docker run -p 8080:8080 --env-file .env runhq-be
```

The Dockerfile uses a multi-stage build (deps → build → run) with Node.js 22 Alpine.
