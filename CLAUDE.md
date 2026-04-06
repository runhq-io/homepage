# Claude Code Project Instructions

## Code Quality is Non-Negotiable

**Always implement the RIGHT, PROPER, and INDUSTRY-LEADING solution. Time is NEVER the factor.**

If one implementation takes 1 minute and another takes 1 year, but the 1-year approach is the correct way — go with the correct way. There are no shortcuts. There are no exceptions.

**NEVER implement:**
- Hackjobs or patchwork fixes
- Hardcoded values where proper abstractions belong
- Simulated or faked functionality
- "Good enough for now" compromises that sacrifice correctness
- Quick workarounds that accumulate technical debt

**ALWAYS implement:**
- The architecturally correct solution
- Proper abstractions, patterns, and data structures
- Real, production-grade implementations — not simulations
- Code that would pass review at the best engineering organizations in the world

## Architecture

This is the RunHQ cloud API — a unified Node.js server combining:
- **Hono** for REST API endpoints (`/api/*`)
- **Next.js 16** for SSR admin dashboard (everything else)
- **WebSocket** for real-time desktop client communication (`/ws`)

All three run on a single port (default `8080`).

### Tech Stack
- **Runtime**: Node.js 22, ESM modules, TypeScript
- **Database**: PostgreSQL via Drizzle ORM (supports Neon serverless)
- **Auth**: NextAuth + JWT
- **Payments**: Stripe
- **Infrastructure**: Fly.io Machines API (server provisioning), Cloudflare (tunnels + DNS)
- **AI**: Anthropic SDK (Claude)

### Project Structure
```
src/
  server.ts          — Entry point (loads env.ts FIRST, then boots everything)
  env.ts             — dotenv loader (must be imported before any other module)
  middleware.ts       — Next.js middleware (CORS, auth, routing)
  api/
    HttpServer.ts    — All Hono REST endpoints
    auth/            — JWT, session management
    services/        — Business logic (FlyService, StripeService, ServerService, etc.)
  app/               — Next.js pages (dashboard, admin, auth, login)
  components/        — React UI components
  db/
    schema.ts        — Drizzle schema definitions
    seed.ts          — Database seeds (agent personas, billing plans)
    index.ts         — DB connection (auto-detects Neon vs standard PG)
  lib/               — Utilities (email, analytics, Fly API helpers)
packages/protocol/   — Shared types between this repo and the server repo
```

## Local Development

```bash
pnpm install
pnpm dev              # Start dev server with hot reload (tsx watch)
```

### Database Commands
```bash
pnpm db:push          # Sync schema to database
pnpm db:generate      # Generate migration files
pnpm db:migrate       # Run migrations
pnpm db:seed          # Seed default data (agent personas, plans)
pnpm db:studio        # Open Drizzle Studio web UI
```

### Required Environment Variables

Copy `.env.example` to `.env` and fill in at minimum:
```
DATABASE_URL=postgresql://...
PORT=9000
JWT_SECRET=<generate with: openssl rand -base64 32>
NEXTAUTH_SECRET=<generate>
AUTH_SECRET=<generate>
AUTH_URL=http://localhost:9000
NEXTAUTH_URL=http://localhost:9000
```

## Deployment

**NEVER deploy to production unless the user explicitly asks you to deploy.**

**See `HOW_TO_DEPLOY.md` for staging and production deployment instructions.**

### Architecture
- **Staging**: Digital Ocean App Platform — auto-deploys on push to `master`
- **Production**: Digital Ocean App Platform — manual deploy via DO dashboard

## Critical Debugging Rule

**NEVER apply symptom-based "bandaid" fixes without understanding root cause.**

**YOU HAVE NOT FIXED A BUG UNTIL YOU HAVE REPRODUCED IT.** No exceptions.

When debugging issues:
1. **REPRODUCE the bug first** — Run the code, see the actual error with evidence
2. **Find the ROOT CAUSE** — Trace through the code path to understand WHY the bug occurs
3. **Fix at the source** — Apply the fix where the problem originates, not where symptoms appear
4. **Verify the fix** — Confirm the bug is fixed

### DO NOT guess at root causes
Reading code and theorizing what MIGHT be wrong is NOT debugging. You MUST:
- Check actual server logs (DO Runtime Logs, `pnpm dev` output)
- See the real error message, not just HTTP status codes
- Reproduce the exact failure before proposing any fix

## Coding Conventions

- **ESM only** — `import`/`export`, no `require()`
- **Path alias** — `@/` maps to `src/`
- **Services export functions**, not classes
- **Environment loading** — `env.ts` must be imported FIRST in `server.ts` before any other module
- **Database** — auto-detects Neon serverless vs standard PostgreSQL via connection string

## Code Review Priorities

When reviewing or modifying code:
1. Understand existing patterns before making changes
2. Prefer minimal, focused changes over sweeping refactors
3. Test changes thoroughly before considering them complete
4. Never commit untested code
