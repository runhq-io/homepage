# Admin Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/admin/usage` page (in `be/`) that displays per-day Claude-credit usage in dollars, broken down by user / server / task / agent, with totals that match Anthropic's billing page within rounding.

**Architecture:** Replace the per-user monthly-aggregate `usage_records` table with a per-call event log (`usage_events`) + a separate admin-adjustment ledger (`usage_adjustments`). Rewrite `calculateCost` to price cache tokens (Anthropic published multipliers). Propagate server/task/agent context from the RunHQ server to `be/`'s proxy via HTTP headers; denormalize labels onto events at insert time since the label sources live in a different database. Admin page is a Next.js 16 Server Component built on a new `UsageReportService` query module.

**Tech Stack:** Next.js 16 (App Router, Server Components), Postgres via Neon, Drizzle ORM 0.38, Hono (for the proxy HTTP layer), Vitest, Tailwind, Recharts (add to `be/` deps), React 19.

**Companion spec:** `docs/superpowers/specs/2026-04-22-admin-usage-design.md`

**Repos touched:** primarily `be/` (one PR). Small PR in `runhq/server/` to send new request-context headers.

---

## File Structure

### `be/` — new files

| Path | Purpose |
|---|---|
| `src/api/services/UsageReportService.ts` | Aggregation queries for the admin usage page (daily totals, breakdowns, CSV stream). No writes. |
| `src/api/services/UsageReportService.test.ts` | Unit tests for UsageReportService. |
| `src/api/services/pricing.ts` | Per-model pricing table + cache-aware `calculateCost` + `pricingForModel`. Shared between HttpServer and tests. Replaces duplicates. |
| `src/api/services/pricing.test.ts` | Pricing-fixture tests; covers all four token kinds × Opus/Sonnet/Haiku. |
| `src/api/services/UsageService.getPeriodSpending.test.ts` | Period-spending helper tests. |
| `src/api/services/UsageService.trackUsage.test.ts` | New `trackUsage` transaction behavior tests. |
| `src/api/services/UsageAdjustments.test.ts` | Admin-adjustment balance + period sum tests. |
| `src/app/admin/usage/page.tsx` | Admin Usage Server Component (root page). |
| `src/app/admin/usage/UsageFilters.tsx` | Interactive filter bar (Client Component). |
| `src/app/admin/usage/UsageChart.tsx` | Daily usage stacked area chart (Client Component — Recharts). |
| `src/app/admin/usage/BreakdownTable.tsx` | Generic breakdown table (Client Component). |
| `src/app/admin/usage/PreCutoverBanner.tsx` | Banner surfacing historical rollups. |
| `src/app/api/admin/usage/csv/route.ts` | CSV streaming endpoint (GET). |
| `scripts/seed-dev-local-user.ts` | Idempotent seed of the dev-local sentinel user for non-prod envs. |

### `be/` — modified files

| Path | Change |
|---|---|
| `src/db/schema.ts` | Add `usageEvents` + `usageAdjustments` tables; remove `usageRecords` + relations + exports. Add `numeric` to drizzle imports. |
| `src/api/HttpServer.ts` | Delete inline `calculateCost`; import from `pricing.ts`. Read new context headers. Extract `userId` at handler level. Pass `costCents` + context + `anthropicRequestId` to new `trackUsage`. |
| `src/api/services/UsageService.ts` | Replace `trackUsage` with new transactional signature. Delete `calculateCostCents`. Delete `getOrCreateCurrentUsageRecord`. Add `getPeriodSpending`. Migrate `getCreditBalance` / `getUsageHistory` / internal balance helpers to events. |
| `src/app/admin/users/page.tsx` | Aggregate `SUM(usage_events.costCents)` instead of `usageRecords.totalCostCents`. |
| `src/app/admin/users/[id]/page.tsx` | Period-spending via `getPeriodSpending`. |
| `src/app/admin/users/[id]/actions.ts` | Credit adjustments insert `usage_adjustments` rows, not mutate `usage_records`. |
| `src/app/admin/users/actions.ts` | User-deletion cascade deletes `usage_events` + `usage_adjustments`. |
| `src/db/index.ts` | Export `usageEvents`, `usageAdjustments`. Remove `usageRecords` export. |
| `src/components/AdminChrome.tsx` | Add "Usage" nav link to admin sidebar/topbar. |
| `package.json` | Add `recharts` dependency. |

### `be/drizzle/`

| Path | Change |
|---|---|
| New `NNNN_usage_events.sql` (auto-numbered) | CREATE usage_events + usage_adjustments + indexes; backfill from usage_records; DROP usage_records. All one migration, one transaction. |

### `runhq/server/` — modified files

| Path | Change |
|---|---|
| `src/services/ClaudeApiService.ts` | Add `ClaudeCallContext` interface. `callWithTools` accepts optional `context`. Send `X-Server-Id` + context headers. |
| Callers of `callWithTools` | Thread `ClaudeCallContext` through where available. |

---

## Task 1: Add `usage_events` + `usage_adjustments` Drizzle schemas

**Files:**
- Modify: `be/src/db/schema.ts`
- Modify: `be/src/db/index.ts`

- [ ] **Step 1: Add `numeric` to Drizzle imports**

Open `be/src/db/schema.ts` line 1. Current:

```ts
import { pgTable, text, timestamp, uuid, boolean, jsonb, integer, bigint, unique, index, uniqueIndex } from 'drizzle-orm/pg-core';
```

Replace with:

```ts
import { pgTable, text, timestamp, uuid, boolean, jsonb, integer, bigint, numeric, unique, index, uniqueIndex } from 'drizzle-orm/pg-core';
```

- [ ] **Step 2: Add `usage_events` and `usage_adjustments` tables**

Append after the existing `usageRecords` block (around line 98). Do **not** remove `usageRecords` yet — that's Task 11.

```ts
// ============================================================================
// Usage Events (per-call event log — source of truth for Claude-call spending)
// ============================================================================

export const usageEvents = pgTable('usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  serverId: text('server_id'),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
  // numeric(12,4) preserves sub-cent precision from calculateCost.
  // Drizzle returns numeric columns as strings; cast at query boundary.
  costCents: numeric('cost_cents', { precision: 12, scale: 4 }).notNull().default('0'),
  // Context (all nullable — best-effort from RunHQ server)
  taskId: text('task_id'),
  taskLabel: text('task_label'),
  channelId: text('channel_id'),
  channelLabel: text('channel_label'),
  agentId: text('agent_id'),
  agentLabel: text('agent_label'),
  conversationId: text('conversation_id'),
  anthropicRequestId: text('anthropic_request_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tsIdx: index('usage_events_ts_idx').on(table.ts.desc()),
  userTsIdx: index('usage_events_user_ts_idx').on(table.userId, table.ts.desc()),
  serverTsIdx: index('usage_events_server_ts_idx').on(table.serverId, table.ts.desc()),
  // Partial indexes for breakdowns — only rows with the ID populated
  taskIdx: index('usage_events_task_idx').on(table.taskId).where(sql`task_id IS NOT NULL`),
  agentIdx: index('usage_events_agent_idx').on(table.agentId).where(sql`agent_id IS NOT NULL`),
}));

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  user: one(users, { fields: [usageEvents.userId], references: [users.id] }),
}));

// ============================================================================
// Usage Adjustments (admin-driven balance changes — grants, refunds, clawbacks)
// ============================================================================

export const usageAdjustments = pgTable('usage_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  adminUserId: uuid('admin_user_id').references(() => users.id).notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  // Signed: negative = refund/credit, positive = additional charge/clawback
  amountCents: numeric('amount_cents', { precision: 12, scale: 4 }).notNull(),
  reason: text('reason').notNull(),
}, (table) => ({
  userTsIdx: index('usage_adjustments_user_ts_idx').on(table.userId, table.ts.desc()),
}));

export const usageAdjustmentsRelations = relations(usageAdjustments, ({ one }) => ({
  user: one(users, { fields: [usageAdjustments.userId], references: [users.id] }),
  admin: one(users, { fields: [usageAdjustments.adminUserId], references: [users.id] }),
}));

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type UsageAdjustment = typeof usageAdjustments.$inferSelect;
export type NewUsageAdjustment = typeof usageAdjustments.$inferInsert;
```

- [ ] **Step 3: Wire up users relations**

In `be/src/db/schema.ts`, find `usersRelations` (search for `usersRelations`). Where it currently lists `usageRecords: many(usageRecords)`, add the new relations (do **not** remove `usageRecords` relation yet):

```ts
export const usersRelations = relations(users, ({ many }) => ({
  // ... existing relations
  usageRecords: many(usageRecords),              // keep for now — removed in Task 11
  usageEvents: many(usageEvents),
  usageAdjustments: many(usageAdjustments),
  adjustmentsAsAdmin: many(usageAdjustments, { relationName: 'admin' }),
}));
```

- [ ] **Step 4: Export from `src/db/index.ts`**

Find `be/src/db/index.ts` and add to the re-export list:

```ts
export { usageEvents, usageAdjustments, usageEventsRelations, usageAdjustmentsRelations } from './schema';
export type { UsageEvent, NewUsageEvent, UsageAdjustment, NewUsageAdjustment } from './schema';
```

- [ ] **Step 5: TypeScript compiles**

Run: `cd /app/data/home/be && pnpm tsc --noEmit`
Expected: PASS (no errors; new tables added, nothing removed yet).

- [ ] **Step 6: Commit**

```bash
cd /app/data/home/be
git add src/db/schema.ts src/db/index.ts
git commit -m "feat(schema): add usage_events and usage_adjustments tables

Per-call Claude usage event log and a separate admin-adjustment ledger.
Retains usage_records for now — readers are migrated in a follow-up task
and the old table is dropped at the end.

Ref: docs/superpowers/specs/2026-04-22-admin-usage-design.md"
```

---

## Task 2: Migration #1 — create new tables + backfill

**Why two migrations?** Drizzle-kit generates migrations by diffing schema.ts against its snapshot file. This PR keeps `usage_records` in schema.ts through Task 10 (so the backfill INSERT can still read from it), and only removes it in Task 11. Doing the DROP in this first migration would desync the snapshot and cause the next `db:generate` run to emit a duplicate DROP. Two migrations keeps the snapshot honest.

**Files:**
- Create: `be/drizzle/NNNN_add_usage_events.sql` (NNNN auto-assigned by drizzle-kit; do not rename)

- [ ] **Step 1: Run drizzle-kit generate**

```bash
cd /app/data/home/be && pnpm db:generate
```

Expected output: creates a new file `drizzle/NNNN_<random_adjective>.sql` containing `CREATE TABLE usage_events` and `CREATE TABLE usage_adjustments` with indexes. Note the actual filename created.

- [ ] **Step 2: Append backfill INSERT to the generated file**

Open the generated file. Drizzle auto-generated the CREATE statements at the top. Append the following SQL at the end, after the last `--> statement-breakpoint`:

```sql
--> statement-breakpoint
-- Backfill usage_events from usage_records as "pre-cutover" rollup rows.
-- ts is coerced to UTC explicitly (period_end is a tz-naive timestamp).
-- The usage_records table itself is dropped later, in Task 11's migration,
-- after all code readers have been migrated off it.
INSERT INTO usage_events (
  user_id, server_id, ts, model,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  cost_cents,
  task_id, task_label, channel_id, channel_label, agent_id, agent_label,
  conversation_id, anthropic_request_id
)
SELECT
  user_id,
  NULL,
  ((period_end - INTERVAL '1 second') AT TIME ZONE 'UTC'),
  'pre-cutover-rollup',
  input_tokens, output_tokens, 0, 0,
  total_cost_cents::numeric(12,4),
  NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL
FROM usage_records;
```

- [ ] **Step 3: Apply migration to local dev DB**

```bash
cd /app/data/home/be && pnpm db:migrate
```

Expected: no errors; migration applied. If local DB has no `usage_records` rows, the backfill INSERT is a no-op.

- [ ] **Step 4: Verify schema on local DB**

```bash
cd /app/data/home/be && psql $DATABASE_URL -c "\d usage_events" -c "\d usage_adjustments" -c "SELECT to_regclass('usage_records');"
```

Expected: both new tables listed with correct columns and indexes; `usage_records` still exists (to_regclass returns `'usage_records'`).

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add drizzle/
git commit -m "db: migration #1 — add usage_events/adjustments + backfill

Creates the two new tables and backfills usage_events from usage_records
as pre-cutover rollup rows. usage_records itself is retained for now —
a second migration drops it after all readers have been migrated."
```

---

## Task 3: Extract pricing module with cache-aware `calculateCost`

**Files:**
- Create: `be/src/api/services/pricing.ts`
- Create: `be/src/api/services/pricing.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `be/src/api/services/pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { calculateCost, pricingForModel } from './pricing';

describe('calculateCost', () => {
  // Anthropic published pricing at spec time, $/MTok:
  //   Opus 4.x:   $5 input / $25 output
  //   Sonnet 4.x: $3 input / $15 output
  //   Haiku 4.5:  $1 input / $5 output
  //   Cache-read: 0.10x input price
  //   Cache-creation (5m ephemeral): 1.25x input price

  it('prices pure input+output for Sonnet', () => {
    // 1M input, 1M output → $3 + $15 = $18 = 1800 cents
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    })).toBeCloseTo(1800, 3);
  });

  it('prices cache-read at 10% of input', () => {
    // 1M cache-read on Sonnet → 1_000_000/1e6 * 3 * 0.10 * 100 = 30 cents
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 1_000_000, cacheCreationTokens: 0,
    })).toBeCloseTo(30, 3);
  });

  it('prices cache-creation at 125% of input', () => {
    // 1M cache-creation on Sonnet → 1e6/1e6 * 3 * 1.25 * 100 = 375 cents
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 1_000_000,
    })).toBeCloseTo(375, 3);
  });

  it('handles mixed token types for Opus', () => {
    // Opus 4.x: input=$5, output=$25
    // 100k input + 50k output + 200k cache-read + 10k cache-creation
    // = 100_000/1e6 * 5 * 100           = 50 cents
    // + 50_000/1e6 * 25 * 100           = 125 cents
    // + 200_000/1e6 * 5 * 0.10 * 100    = 10 cents
    // + 10_000/1e6 * 5 * 1.25 * 100     = 6.25 cents
    // = 191.25 cents
    expect(calculateCost('claude-opus-4-7', {
      inputTokens: 100_000, outputTokens: 50_000,
      cacheReadTokens: 200_000, cacheCreationTokens: 10_000,
    })).toBeCloseTo(191.25, 3);
  });

  it('prices Haiku 4.5 correctly', () => {
    // Haiku 4.5: input=$1, output=$5
    // 1M input + 1M output = $1 + $5 = 600 cents
    expect(calculateCost('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    })).toBeCloseTo(600, 3);
  });

  it('returns 0 for zero tokens', () => {
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    })).toBe(0);
  });

  it('falls back to default pricing for unknown model (and warns)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Unknown model → default Sonnet-tier pricing
    const cost = calculateCost('claude-some-future-model', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    expect(cost).toBeCloseTo(300, 3); // $3 per 1M input
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('claude-some-future-model'));
    warnSpy.mockRestore();
  });
});

describe('pricingForModel', () => {
  it('returns exact match when model is known', () => {
    expect(pricingForModel('claude-opus-4-7')).toEqual({ input: 5, output: 25 });
  });

  it('returns default when model is unknown', () => {
    expect(pricingForModel('claude-unknown-model')).toEqual({ input: 3, output: 15 });
  });
});
```

Add `vi` to imports at the top:

```ts
import { describe, it, expect, vi } from 'vitest';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/pricing.test.ts`
Expected: FAIL — `Cannot find module './pricing'` or similar.

- [ ] **Step 3: Implement the pricing module**

Create `be/src/api/services/pricing.ts`:

```ts
/**
 * Token usage from an Anthropic Messages API response, in its four kinds.
 */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;  // 5-min ephemeral tier; 1h tier not used by RunHQ today
}

interface ModelPrice {
  input: number;   // $ per 1M tokens
  output: number;  // $ per 1M tokens
}

// Anthropic's cache multipliers, uniform across models that support prompt caching.
const CACHE_READ_MULTIPLIER = 0.10;
const CACHE_CREATION_5M_MULTIPLIER = 1.25;

// Per-model pricing. If adding a new model:
//   - confirm prices against https://www.anthropic.com/pricing
//   - keep both aliased variants (dated + '-latest' or shortname) mapped to the same struct
const PRICING: Record<string, ModelPrice> = {
  // Claude 3.5 (legacy but still routable)
  'claude-3-5-sonnet-20241022': { input: 3,   output: 15 },
  'claude-3-5-sonnet-latest':   { input: 3,   output: 15 },
  'claude-3-5-haiku-20241022':  { input: 0.8, output: 4 },
  'claude-3-5-haiku-latest':    { input: 0.8, output: 4 },
  // Claude 3 Opus (legacy)
  'claude-3-opus-20240229': { input: 15, output: 75 },
  'claude-3-opus-latest':   { input: 15, output: 75 },
  // Claude 4.x current
  'claude-sonnet-4-20250514':   { input: 3, output: 15 },
  'claude-sonnet-4-6':          { input: 3, output: 15 },
  'claude-opus-4-20250514':     { input: 5, output: 25 },
  'claude-opus-4-6':            { input: 5, output: 25 },
  'claude-opus-4-7':            { input: 5, output: 25 },
  'claude-haiku-4-5-20251001':  { input: 1, output: 5 },
};

const DEFAULT_PRICING: ModelPrice = { input: 3, output: 15 };

export function pricingForModel(model: string): ModelPrice {
  return PRICING[model] ?? DEFAULT_PRICING;
}

/**
 * Calculate the cost of a single API call in cents (with sub-cent precision).
 * Storage columns are numeric(12,4) — do NOT round here.
 *
 * Unknown models emit a warning and fall back to Sonnet pricing. This keeps
 * us running but flags model lineup drift in logs for the operator.
 */
export function calculateCost(model: string, tokens: TokenCounts): number {
  if (!(model in PRICING)) {
    console.warn(`[pricing] Unknown model '${model}' — falling back to default Sonnet-tier pricing. Update PRICING in src/api/services/pricing.ts.`);
  }
  const price = pricingForModel(model);

  const inputCents         = (tokens.inputTokens         / 1_000_000) * price.input                                          * 100;
  const outputCents        = (tokens.outputTokens        / 1_000_000) * price.output                                         * 100;
  const cacheReadCents     = (tokens.cacheReadTokens     / 1_000_000) * price.input * CACHE_READ_MULTIPLIER                  * 100;
  const cacheCreationCents = (tokens.cacheCreationTokens / 1_000_000) * price.input * CACHE_CREATION_5M_MULTIPLIER           * 100;

  return inputCents + outputCents + cacheReadCents + cacheCreationCents;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/pricing.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/pricing.ts src/api/services/pricing.test.ts
git commit -m "feat(pricing): extract pricing module with cache-aware calculateCost

- Prices input, output, cache-read (0.1x input), cache-creation-5m (1.25x input).
- Adds claude-opus-4-7 to pricing table (was missing — silently fell back to Sonnet).
- Emits a warning when an unknown model is seen so operators notice drift.
- Storage columns are numeric(12,4); function preserves sub-cent precision."
```

---

## Task 4: Implement `getPeriodSpending` helper

**Files:**
- Modify: `be/src/api/services/UsageService.ts`
- Create: `be/src/api/services/UsageService.getPeriodSpending.test.ts`

- [ ] **Step 1: Write the failing test**

Create `be/src/api/services/UsageService.getPeriodSpending.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, users, subscriptions, usageEvents, usageAdjustments } from '@/db';
import { getPeriodSpending } from './UsageService';
import { eq } from 'drizzle-orm';

// This is an INTEGRATION test: hits the real local test DB.
// Vitest project must set DATABASE_URL to a test DB before running.

describe('getPeriodSpending', () => {
  const testUserId = '00000000-0000-0000-0000-000000000aaa';
  const start = new Date('2026-04-01T00:00:00Z');
  const end   = new Date('2026-05-01T00:00:00Z');

  beforeEach(async () => {
    // Clean slate for this user
    await db.delete(usageEvents).where(eq(usageEvents.userId, testUserId));
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, testUserId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
    await db.insert(users).values({ id: testUserId, email: 'gp-test@example.com' } as any);
  });

  it('returns zeros when no events exist', async () => {
    const r = await getPeriodSpending(testUserId, start, end);
    expect(r).toEqual({
      inputTokens: 0, outputTokens: 0, totalCostCents: 0, requestCount: 0,
    });
  });

  it('sums events within the period', async () => {
    await db.insert(usageEvents).values([
      {
        userId: testUserId, ts: new Date('2026-04-10T12:00:00Z'),
        model: 'claude-sonnet-4-6',
        inputTokens: 1000, outputTokens: 500,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '10.5000',
      },
      {
        userId: testUserId, ts: new Date('2026-04-20T12:00:00Z'),
        model: 'claude-sonnet-4-6',
        inputTokens: 2000, outputTokens: 1000,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '21.0000',
      },
    ]);

    const r = await getPeriodSpending(testUserId, start, end);
    expect(r.inputTokens).toBe(3000);
    expect(r.outputTokens).toBe(1500);
    expect(r.totalCostCents).toBeCloseTo(31.5, 3);
    expect(r.requestCount).toBe(2);
  });

  it('excludes events outside the period', async () => {
    await db.insert(usageEvents).values([
      {
        userId: testUserId, ts: new Date('2026-03-31T23:59:59Z'),  // before start
        model: 'claude-sonnet-4-6',
        inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '1.0000',
      },
      {
        userId: testUserId, ts: new Date('2026-04-10T12:00:00Z'),  // in
        model: 'claude-sonnet-4-6',
        inputTokens: 1000, outputTokens: 500,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '10.0000',
      },
      {
        userId: testUserId, ts: new Date('2026-05-01T00:00:01Z'),  // after end
        model: 'claude-sonnet-4-6',
        inputTokens: 500, outputTokens: 250,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '5.0000',
      },
    ]);

    const r = await getPeriodSpending(testUserId, start, end);
    expect(r.requestCount).toBe(1);
    expect(r.totalCostCents).toBeCloseTo(10, 3);
  });

  it('sums usage_adjustments alongside events', async () => {
    await db.insert(usageEvents).values({
      userId: testUserId, ts: new Date('2026-04-10T12:00:00Z'),
      model: 'claude-sonnet-4-6',
      inputTokens: 1000, outputTokens: 500,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      costCents: '10.0000',
    });
    await db.insert(usageAdjustments).values({
      userId: testUserId, adminUserId: testUserId,  // self-adjust just for test
      ts: new Date('2026-04-15T12:00:00Z'),
      amountCents: '-2.5000',  // refund
      reason: 'test refund',
    });

    const r = await getPeriodSpending(testUserId, start, end);
    expect(r.totalCostCents).toBeCloseTo(7.5, 3);
    expect(r.requestCount).toBe(1); // adjustments don't count as requests
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageService.getPeriodSpending.test.ts`
Expected: FAIL — `getPeriodSpending is not a function` or similar.

- [ ] **Step 3: Implement the helper**

Open `be/src/api/services/UsageService.ts`. Add these imports at the top (merge with existing):

```ts
import { usageEvents, usageAdjustments } from '@/db';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
```

Append this function:

```ts
export interface PeriodSpending {
  inputTokens: number;
  outputTokens: number;
  totalCostCents: number;
  requestCount: number;
}

/**
 * Sum spending for one user across a time range, across BOTH Claude-call events
 * and admin adjustments. Returns totals with sub-cent precision.
 *
 * Implemented as two aggregate queries in parallel; at RunHQ's scale this is
 * sub-millisecond. If usage grows 100x, add a materialized rollup then — not now.
 */
export async function getPeriodSpending(
  userId: string,
  start: Date,
  end: Date,
): Promise<PeriodSpending> {
  const [eventsAgg, adjAgg] = await Promise.all([
    db.select({
      inputTokens:    sql<number>`COALESCE(SUM(${usageEvents.inputTokens}),  0)::int`,
      outputTokens:   sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount:   sql<number>`COUNT(*)::int`,
    })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.userId, userId),
      gte(usageEvents.ts, start),
      lte(usageEvents.ts, end),
    )),

    db.select({
      totalAdjustCents: sql<number>`COALESCE(SUM(${usageAdjustments.amountCents}), 0)::double precision`,
    })
    .from(usageAdjustments)
    .where(and(
      eq(usageAdjustments.userId, userId),
      gte(usageAdjustments.ts, start),
      lte(usageAdjustments.ts, end),
    )),
  ]);

  const e = eventsAgg[0];
  const a = adjAgg[0];

  return {
    inputTokens:  e.inputTokens,
    outputTokens: e.outputTokens,
    totalCostCents: e.totalCostCents + a.totalAdjustCents,
    requestCount: e.requestCount,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageService.getPeriodSpending.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/UsageService.ts src/api/services/UsageService.getPeriodSpending.test.ts
git commit -m "feat(usage): getPeriodSpending helper — sums events + adjustments

Replaces the single-row usage_records lookup. Queries events + adjustments
tables in parallel. Returns sub-cent precision (double precision cast).
At current scale these aggregates are sub-millisecond; no rollup table needed."
```

---

## Task 5: Rewrite `trackUsage` with transaction + new signature

**Files:**
- Modify: `be/src/api/services/UsageService.ts`
- Create: `be/src/api/services/UsageService.trackUsage.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `be/src/api/services/UsageService.trackUsage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, users, subscriptions, usageEvents } from '@/db';
import { trackUsage } from './UsageService';
import { eq } from 'drizzle-orm';

describe('trackUsage', () => {
  const testUserId = '00000000-0000-0000-0000-000000000bbb';

  beforeEach(async () => {
    await db.delete(usageEvents).where(eq(usageEvents.userId, testUserId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
    await db.insert(users).values({ id: testUserId, email: 'track-test@example.com' } as any);
    await db.insert(subscriptions).values({
      userId: testUserId, planId: 'free', status: 'active', creditBalanceCents: 10000,
    } as any);
  });

  it('inserts an event and deducts balance atomically', async () => {
    await trackUsage({
      userId: testUserId,
      model: 'claude-sonnet-4-6',
      tokens: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costCents: 10.5,  // sub-cent precision
      context: { serverId: 'test-server-1', taskId: null, taskLabel: null,
                 channelId: null, channelLabel: null, agentId: null, agentLabel: null,
                 conversationId: null },
      anthropicRequestId: 'req_test_123',
    });

    const events = await db.select().from(usageEvents).where(eq(usageEvents.userId, testUserId));
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe('claude-sonnet-4-6');
    expect(events[0].serverId).toBe('test-server-1');
    expect(Number(events[0].costCents)).toBeCloseTo(10.5, 3);

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, testUserId));
    // 10000 cents - 10.5 cents = 9989.5; subscriptions.credit_balance_cents is integer,
    // so balance is rounded to the nearest whole cent before writing.
    expect(sub.creditBalanceCents).toBe(9990);
  });

  it('clamps balance at 0 (does not go negative)', async () => {
    await db.update(subscriptions)
      .set({ creditBalanceCents: 5 })
      .where(eq(subscriptions.userId, testUserId));

    await trackUsage({
      userId: testUserId,
      model: 'claude-sonnet-4-6',
      tokens: { inputTokens: 10_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costCents: 3000,  // way over balance
      context: { serverId: null, taskId: null, taskLabel: null,
                 channelId: null, channelLabel: null, agentId: null, agentLabel: null,
                 conversationId: null },
      anthropicRequestId: null,
    });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, testUserId));
    expect(sub.creditBalanceCents).toBe(0);
    // Event is still written even when balance was insufficient — we already called Anthropic.
    const events = await db.select().from(usageEvents).where(eq(usageEvents.userId, testUserId));
    expect(events).toHaveLength(1);
    expect(Number(events[0].costCents)).toBeCloseTo(3000, 3);
  });

  it('persists all context fields', async () => {
    await trackUsage({
      userId: testUserId,
      model: 'claude-opus-4-7',
      tokens: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 30 },
      costCents: 1.234,
      context: {
        serverId: 'fly-machine-abc',
        taskId: 'task-1',     taskLabel: 'Fix login bug',
        channelId: 'chan-1',  channelLabel: '#engineering',
        agentId: 'agent-1',   agentLabel: 'QA Bot',
        conversationId: 'conv-1',
      },
      anthropicRequestId: 'req_xyz',
    });

    const [e] = await db.select().from(usageEvents).where(eq(usageEvents.userId, testUserId));
    expect(e.serverId).toBe('fly-machine-abc');
    expect(e.taskId).toBe('task-1');
    expect(e.taskLabel).toBe('Fix login bug');
    expect(e.channelId).toBe('chan-1');
    expect(e.channelLabel).toBe('#engineering');
    expect(e.agentId).toBe('agent-1');
    expect(e.agentLabel).toBe('QA Bot');
    expect(e.conversationId).toBe('conv-1');
    expect(e.anthropicRequestId).toBe('req_xyz');
    expect(e.cacheReadTokens).toBe(50);
    expect(e.cacheCreationTokens).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageService.trackUsage.test.ts`
Expected: FAIL — the current trackUsage signature doesn't match (takes `userToken`, not options object).

- [ ] **Step 3: Replace `trackUsage` implementation**

Open `be/src/api/services/UsageService.ts`. Locate the current `trackUsage` (around line 328) and the `getOrCreateCurrentUsageRecord` function (around line 290). Replace both with:

```ts
import type { TokenCounts } from './pricing';

export interface TrackUsageContext {
  serverId: string | null;
  taskId: string | null;
  taskLabel: string | null;
  channelId: string | null;
  channelLabel: string | null;
  agentId: string | null;
  agentLabel: string | null;
  conversationId: string | null;
}

export interface TrackUsageInput {
  userId: string;
  model: string;
  tokens: TokenCounts;
  costCents: number;               // computed by caller using pricing.calculateCost
  context: TrackUsageContext;
  anthropicRequestId: string | null;
}

/**
 * Persist one Claude-call event and deduct the cost from the user's balance.
 * Both operations happen in one DB transaction — either both succeed or neither.
 *
 * Balance is clamped at 0 (existing behavior; debt is not tracked).
 */
export async function trackUsage(input: TrackUsageInput): Promise<void> {
  const { userId, model, tokens, costCents, context, anthropicRequestId } = input;

  await db.transaction(async (tx) => {
    // Deduct balance atomically using SQL GREATEST(0, balance - cost).
    // creditBalanceCents is an integer column — round before writing.
    const costWhole = Math.round(costCents);
    await tx
      .update(subscriptions)
      .set({
        creditBalanceCents: sql`GREATEST(0, ${subscriptions.creditBalanceCents} - ${costWhole})`,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.userId, userId));

    // Insert the event with full precision cost.
    await tx.insert(usageEvents).values({
      userId,
      serverId: context.serverId,
      ts: new Date(),
      model,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheCreationTokens: tokens.cacheCreationTokens,
      costCents: costCents.toFixed(4),  // numeric column expects string
      taskId: context.taskId,
      taskLabel: context.taskLabel,
      channelId: context.channelId,
      channelLabel: context.channelLabel,
      agentId: context.agentId,
      agentLabel: context.agentLabel,
      conversationId: context.conversationId,
      anthropicRequestId,
    });
  });
}

// Delete calculateCostCents entirely — pricing now lives in ./pricing.ts
// Delete getOrCreateCurrentUsageRecord entirely — no monthly rollup table.
```

Remove the old `calculateCostCents` function (around line 128) and the old `getOrCreateCurrentUsageRecord` (around line 290).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageService.trackUsage.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/UsageService.ts src/api/services/UsageService.trackUsage.test.ts
git commit -m "feat(usage): rewrite trackUsage — transactional, events-based

- New signature: options object with userId, tokens, costCents, context.
- Wraps balance deduction + event insert in db.transaction; fixes pre-existing
  race where the two updates were non-atomic.
- Deletes calculateCostCents (duplicate of pricing.calculateCost).
- Deletes getOrCreateCurrentUsageRecord (no more monthly rollup table).
- Balance clamp at 0 is preserved (existing behavior)."
```

---

## Task 6: Seed `dev-local` sentinel user for non-prod envs

**Files:**
- Create: `be/scripts/seed-dev-local-user.ts`
- Modify: `be/src/api/HttpServer.ts` (add startup call)

- [ ] **Step 1: Create the seed script**

Create `be/scripts/seed-dev-local-user.ts`:

```ts
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';

// Fixed UUID so the dev-local user's ID is stable across restarts.
export const DEV_LOCAL_USER_ID = '00000000-0000-0000-0000-00000000dev0';

/**
 * Seed a stable 'dev-local' user in non-prod environments.
 * Used as the fallback userId for the dev-mode auth bypass at
 * POST /api/claude/tools so events from unauthenticated dev calls
 * still satisfy the usage_events.user_id NOT NULL FK constraint.
 *
 * Idempotent — safe to call on every server startup.
 */
export async function seedDevLocalUser(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;

  const existing = await db.select().from(users).where(eq(users.id, DEV_LOCAL_USER_ID)).limit(1);
  if (existing.length > 0) return;

  await db.insert(users).values({
    id: DEV_LOCAL_USER_ID,
    email: 'dev-local@runhq.invalid',
    name: 'Dev Local (sentinel)',
    // Cast required because `users` table schema may have additional required fields;
    // add defaults for any other NOT NULL cols as needed.
  } as any);

  console.log(`[seed] Inserted dev-local sentinel user id=${DEV_LOCAL_USER_ID}`);
}
```

- [ ] **Step 2: Wire it into startup**

Open `be/src/api/HttpServer.ts`. Near the top, import:

```ts
import { seedDevLocalUser, DEV_LOCAL_USER_ID } from '../../../scripts/seed-dev-local-user';
```

(Adjust relative path if the import resolver requires `@/scripts/...` — check `tsconfig.json` `paths`.)

Find the server's `listen` / startup hook (search for `app.listen` or the equivalent in this codebase; the Hono entry is typically `serve(app)` or similar — look near the top of `HttpServer.ts` or the file that calls into it). Before starting to listen, `await seedDevLocalUser();`.

If startup is elsewhere (search `/app/data/home/be/src` for `app.listen\|serve(app)` to confirm), put the call at the earliest bootstrap point.

- [ ] **Step 3: Verify seed runs without errors**

Run the dev server locally:

```bash
cd /app/data/home/be && pnpm dev
```

Expected: first-run log line `[seed] Inserted dev-local sentinel user id=...`. Second run should be silent (idempotent).

Verify: `psql $DATABASE_URL -c "SELECT id, email FROM users WHERE id = '00000000-0000-0000-0000-00000000dev0';"` returns one row.

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/be
git add scripts/seed-dev-local-user.ts src/api/HttpServer.ts
git commit -m "feat(dev): seed dev-local sentinel user on non-prod startup

Used as fallback userId for the dev-mode auth bypass on /api/claude/tools.
Satisfies the new usage_events.user_id NOT NULL FK for unauthenticated
local calls. Idempotent; no-op in production."
```

---

## Task 7: Update `POST /api/claude/tools` handler

**Files:**
- Modify: `be/src/api/HttpServer.ts` (lines 675-880)

- [ ] **Step 1: Add header validators (top of file or adjacent to the route handler)**

Open `be/src/api/HttpServer.ts`. Near the top-level imports, add:

```ts
import { calculateCost, type TokenCounts } from './services/pricing';
import { trackUsage, type TrackUsageContext } from './services/UsageService';
import { DEV_LOCAL_USER_ID } from '../../scripts/seed-dev-local-user';
```

Just above the `app.post('/api/claude/tools', ...)` definition (around line 675), add:

```ts
// Strict ID validation: opaque IDs are alphanumeric + [_-], max 128 chars.
// Fly machine IDs, UUIDs, and our own generated IDs all fit.
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function readContextHeaders(c: any): TrackUsageContext {
  const idOrNull = (s: string | undefined): string | null =>
    (s && CONTEXT_ID_PATTERN.test(s)) ? s : null;

  const labelOrNull = (s: string | undefined, max = 256): string | null => {
    if (!s) return null;
    try {
      return decodeURIComponent(s).slice(0, max);
    } catch {
      return null;
    }
  };

  return {
    serverId:       idOrNull(c.req.header('X-Server-Id')),
    taskId:         idOrNull(c.req.header('X-Task-Id')),
    taskLabel:      labelOrNull(c.req.header('X-Task-Label')),
    channelId:      idOrNull(c.req.header('X-Channel-Id')),
    channelLabel:   labelOrNull(c.req.header('X-Channel-Label')),
    agentId:        idOrNull(c.req.header('X-Agent-Id')),
    agentLabel:     labelOrNull(c.req.header('X-Agent-Label')),
    conversationId: idOrNull(c.req.header('X-Conversation-Id')),
  };
}
```

Also add a local helper to extract userId from the Authorization token (if one doesn't already exist at this file level — currently it's inside `UsageService.ts` as `extractUserIdFromToken`). Re-export it:

In `src/api/services/UsageService.ts` (if not already exported), add `export` to the existing `extractUserIdFromToken` function declaration.

- [ ] **Step 2: Replace the usage-tracking block in the handler**

In `HttpServer.ts` around lines 820-870, find the block that currently reads:

```ts
const cacheCreation = (response.usage as any)?.cache_creation_input_tokens || 0;
const cacheRead = (response.usage as any)?.cache_read_input_tokens || 0;
// ...
const tokenCostCents = calculateCost(model, inputTokens, outputTokens);
// ...
await UsageService.trackUsage(token, tokenUsage);
```

Replace the whole usage-tracking block with:

```ts
// Extract token counts in all four kinds.
const rawUsage: any = response.usage || {};
const tokens: TokenCounts = {
  inputTokens:         rawUsage.input_tokens          || 0,
  outputTokens:        rawUsage.output_tokens         || 0,
  cacheReadTokens:     rawUsage.cache_read_input_tokens     || 0,
  cacheCreationTokens: rawUsage.cache_creation_input_tokens || 0,
};

// Compute cost once, using the shared pricing module.
const costCents = calculateCost(model, tokens);

// Resolve userId: the verified JWT claim in prod; the dev-local sentinel in dev bypass.
const context = readContextHeaders(c);
const userId = token
  ? UsageService.extractUserIdFromToken(token)
  : (isDev ? DEV_LOCAL_USER_ID : null);

if (userId) {
  // Best-effort anthropic request ID from response or headers.
  const anthropicRequestId = (response as any)?.id ?? null;

  try {
    await trackUsage({
      userId, model, tokens, costCents, context, anthropicRequestId,
    });
  } catch (err) {
    // Log but do NOT fail the response — the user already got their Claude answer.
    console.error('[HttpServer] trackUsage failed', err);
  }

  console.log(
    `[HttpServer] usage model=${model} user=${userId.substring(0, 8)} server=${context.serverId ?? '-'} ` +
    `tokens in=${tokens.inputTokens} out=${tokens.outputTokens} cr=${tokens.cacheReadTokens} cc=${tokens.cacheCreationTokens} ` +
    `cost=${costCents.toFixed(4)}¢`,
  );
}

// Response payload unchanged — the client still gets costCents and balance info.
// (Balance comes from subscriptions.creditBalanceCents after the deduct.)
```

Remove the now-unused local `calculateCost` function at `HttpServer.ts:4971` entirely — the shared `pricing.ts` module owns it.

- [ ] **Step 3: Verify type-checks**

Run: `cd /app/data/home/be && pnpm tsc --noEmit`
Expected: PASS (new imports resolve; removed function has no remaining callers after the replacement).

- [ ] **Step 4: Manual smoke test**

Start the dev server and hit `/api/claude/tools` with a known-good JWT:

```bash
cd /app/data/home/be && pnpm dev &
# In another terminal, send a minimal request. Use a token from your local dev user.
curl -X POST http://localhost:3000/api/claude/tools \
  -H 'Authorization: Bearer <dev-user-jwt>' \
  -H 'Content-Type: application/json' \
  -H 'X-Server-Id: test-machine-abc' \
  -H 'X-Task-Id: task-xyz' \
  -H 'X-Task-Label: Fix%20login%20bug' \
  -d '{"system":"you are a test","messages":[{"role":"user","content":"hi"}],"tools":[],"model":"claude-sonnet-4-6"}'
```

Expected: 200 response. Then verify the event:

```bash
psql $DATABASE_URL -c "SELECT user_id, server_id, task_id, task_label, cost_cents, model FROM usage_events ORDER BY ts DESC LIMIT 1;"
```

Expected: one row with `server_id = 'test-machine-abc'`, `task_id = 'task-xyz'`, `task_label = 'Fix login bug'` (decoded).

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/HttpServer.ts src/api/services/UsageService.ts
git commit -m "feat(proxy): emit usage_events from /api/claude/tools

- Reads X-Server-Id + X-Task-Id/Label + X-Channel-Id/Label + X-Agent-Id/Label +
  X-Conversation-Id with strict validation (ID pattern, label length cap).
- Computes cache-aware cost via shared pricing module.
- Calls new transactional trackUsage().
- Dev-mode bypass uses DEV_LOCAL_USER_ID so FK constraint holds.
- Deletes inline calculateCost (now lives in pricing.ts)."
```

---

## Task 8: Migrate internal `UsageService.ts` readers

**Files:**
- Modify: `be/src/api/services/UsageService.ts` (readers at lines 414-421, 501-506, 618-640, 654-681)

- [ ] **Step 1: Identify every reader and rewrite**

Open `be/src/api/services/UsageService.ts`. Find each of these functions and rewrite their `usageRecords` access to use `getPeriodSpending`. Show of representative rewrites:

`getCreditBalance` (currently reads `usageRecord.totalCostCents`): replace the `db.query.usageRecords.findFirst({...})` + derived `periodSpentCents` with:

```ts
// Replace: const usageRecord = await db.query.usageRecords.findFirst({ ... });
// Replace: periodSpentCents: usageRecord.totalCostCents || 0
const period = getBillingPeriod();
const spending = await getPeriodSpending(userId, period.start, period.end);
// ...later...
periodSpentCents: spending.totalCostCents,
```

`getUsageHistory` (returns monthly rows): rewrite as a grouped query over events:

```ts
export async function getUsageHistory(userId: string, start: Date, end: Date) {
  return db
    .select({
      period: sql<string>`to_char(date_trunc('month', ${usageEvents.ts}), 'YYYY-MM')`,
      inputTokens:    sql<number>`COALESCE(SUM(${usageEvents.inputTokens}),  0)::int`,
      outputTokens:   sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount:   sql<number>`COUNT(*)::int`,
    })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.userId, userId),
      gte(usageEvents.ts, start),
      lte(usageEvents.ts, end),
    ))
    .groupBy(sql`date_trunc('month', ${usageEvents.ts})`)
    .orderBy(sql`date_trunc('month', ${usageEvents.ts})`);
}
```

For each of the other internal balance helpers at lines 618-640 and 654-681 (search for `usageRecord.totalCostCents` — that's the tell): replace the single-row lookup with a `getPeriodSpending(userId, period.start, period.end)` call.

- [ ] **Step 2: Remove now-unused imports and functions**

At the top of `UsageService.ts`, remove `usageRecords` from the `@/db` imports — but ONLY once no references remain in the file:

```bash
cd /app/data/home/be && grep -n "usageRecords" src/api/services/UsageService.ts
```

Expected after migration: empty. Then remove from imports.

- [ ] **Step 3: TypeScript compiles**

Run: `cd /app/data/home/be && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify existing credit-balance tests still pass**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageService`
Expected: all UsageService tests PASS (including pre-existing checkCreditBalance tests, which operate on the unchanged balance field).

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/UsageService.ts
git commit -m "refactor(usage): migrate internal UsageService readers to events

getCreditBalance, getUsageHistory, and internal balance helpers now query
usage_events via getPeriodSpending instead of the soon-to-be-dropped
usage_records table. Behavior unchanged for callers."
```

---

## Task 9: Migrate admin user list + detail pages

**Files:**
- Modify: `be/src/app/admin/users/page.tsx` (lines 16-18)
- Modify: `be/src/app/admin/users/[id]/page.tsx` (lines 37-43)
- Modify: `be/src/app/admin/users/actions.ts` (line 76)

- [ ] **Step 1: Rewrite `/admin/users` aggregation**

In `be/src/app/admin/users/page.tsx`, around lines 14-20, replace:

```ts
// OLD:
db.select({
  userId: usageRecords.userId,
  totalUsageCents: sql<number>`sum(${usageRecords.totalCostCents})`.as('total_usage_cents'),
}).from(usageRecords).groupBy(usageRecords.userId),
```

with:

```ts
// NEW: sum events + adjustments per user
db.select({
  userId: usageEvents.userId,
  totalUsageCents: sql<number>`sum(${usageEvents.costCents})::double precision`.as('total_usage_cents'),
}).from(usageEvents).groupBy(usageEvents.userId),
```

If admin adjustments should also be reflected in the "total usage" column (recommended for an accurate number), add a second parallel query that sums `usage_adjustments.amountCents` per user, and combine the two maps when building rows. Adapt by adding in the same `Promise.all` block:

```ts
db.select({
  userId: usageAdjustments.userId,
  totalAdjustCents: sql<number>`sum(${usageAdjustments.amountCents})::double precision`.as('total_adjust_cents'),
}).from(usageAdjustments).groupBy(usageAdjustments.userId),
```

…and combine: `totalUsageCents = (usageByUser.get(user.id) || 0) + (adjustByUser.get(user.id) || 0)`.

Update imports at the top — remove `usageRecords`, add `usageEvents, usageAdjustments`:

```ts
import { db, users, subscriptions, plans, usageEvents, usageAdjustments, payments, adminUsers, measureQuery } from '@/db';
```

- [ ] **Step 2: Rewrite `/admin/users/[id]` period query**

In `be/src/app/admin/users/[id]/page.tsx`, around lines 37-43:

```ts
// OLD: db.select().from(usageRecords).where(...periodStart/periodEnd...)
// NEW:
import { getPeriodSpending } from '@/api/services/UsageService';
// ...
const spending = await getPeriodSpending(userId, startOfMonth, endOfMonth);
// Use spending.{inputTokens, outputTokens, totalCostCents, requestCount} where
// the old usageRecord row was accessed.
```

Remove `usageRecords` from the `@/db` imports in this file.

- [ ] **Step 3: Rewrite user-deletion cascade**

In `be/src/app/admin/users/actions.ts` at line 76:

```ts
// OLD:
db.delete(usageRecords).where(eq(usageRecords.userId, userId)),
// NEW:
db.delete(usageEvents).where(eq(usageEvents.userId, userId)),
db.delete(usageAdjustments).where(eq(usageAdjustments.userId, userId)),
```

Update imports accordingly.

- [ ] **Step 4: TypeScript compiles**

Run: `cd /app/data/home/be && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

```bash
cd /app/data/home/be && pnpm dev
```

Open `http://localhost:3000/admin/users` and confirm the table renders without errors and `Total Usage` column shows numbers (will be the same per-user totals as before, now derived from events+adjustments).

Open `http://localhost:3000/admin/users/<some-user-id>` and confirm the current-period section shows values (zero if no events this period yet).

- [ ] **Step 6: Commit**

```bash
cd /app/data/home/be
git add src/app/admin/users/
git commit -m "refactor(admin): migrate /admin/users pages from usage_records to events

Aggregates use sum(usage_events.cost_cents) + sum(usage_adjustments.amount_cents).
Per-user detail page uses getPeriodSpending helper.
User-deletion cascade drops from both new tables.
Behavior-equivalent to the old implementation for existing data (preserved via backfill)."
```

---

## Task 10: Migrate admin credit-adjustment action to `usage_adjustments`

**Files:**
- Modify: `be/src/app/admin/users/[id]/actions.ts` (lines 100-120)
- Create: `be/src/api/services/UsageAdjustments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `be/src/api/services/UsageAdjustments.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, users, subscriptions, usageAdjustments } from '@/db';
import { applyAdjustment } from './UsageAdjustments';
import { getPeriodSpending } from './UsageService';
import { eq } from 'drizzle-orm';

describe('applyAdjustment', () => {
  const userId  = '00000000-0000-0000-0000-000000000ccc';
  const adminId = '00000000-0000-0000-0000-000000000ddd';

  beforeEach(async () => {
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, adminId));
    await db.insert(users).values([
      { id: userId,  email: 'adj-test@example.com' } as any,
      { id: adminId, email: 'admin-test@example.com' } as any,
    ]);
    await db.insert(subscriptions).values({
      userId, planId: 'free', status: 'active', creditBalanceCents: 10000,
    } as any);
  });

  it('a positive adjustment (charge more) reduces balance and records the row', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: 500, reason: 'correction' });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub.creditBalanceCents).toBe(9500);

    const rows = await db.select().from(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountCents)).toBe(500);
    expect(rows[0].reason).toBe('correction');
    expect(rows[0].adminUserId).toBe(adminId);
  });

  it('a negative adjustment (refund) increases balance', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: -200, reason: 'refund for outage' });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub.creditBalanceCents).toBe(10200);
  });

  it('adjustments appear in getPeriodSpending', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: 50, reason: 'test' });
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 60_000);
    const r = await getPeriodSpending(userId, start, end);
    expect(r.totalCostCents).toBeCloseTo(50, 3);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageAdjustments.test.ts`
Expected: FAIL — `Cannot find module './UsageAdjustments'`.

- [ ] **Step 3: Create `UsageAdjustments.ts`**

Create `be/src/api/services/UsageAdjustments.ts`:

```ts
import { db, subscriptions, usageAdjustments } from '@/db';
import { eq, sql } from 'drizzle-orm';

export interface ApplyAdjustmentInput {
  userId: string;
  adminUserId: string;
  amountCents: number;   // signed: positive = charge more, negative = refund/credit
  reason: string;
}

/**
 * Apply an admin-initiated balance adjustment.
 *
 * Positive amountCents = additional charge (balance decreases).
 * Negative amountCents = refund or credit grant (balance increases).
 *
 * The adjustment is persisted to usage_adjustments and the balance is updated
 * in the same transaction.
 */
export async function applyAdjustment(input: ApplyAdjustmentInput): Promise<void> {
  const { userId, adminUserId, amountCents, reason } = input;
  if (!reason.trim()) throw new Error('applyAdjustment: reason is required');
  const wholeAmount = Math.round(amountCents);

  await db.transaction(async (tx) => {
    await tx
      .update(subscriptions)
      .set({
        creditBalanceCents: sql`GREATEST(0, ${subscriptions.creditBalanceCents} - ${wholeAmount})`,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.userId, userId));

    await tx.insert(usageAdjustments).values({
      userId,
      adminUserId,
      amountCents: amountCents.toFixed(4),
      reason,
    });
  });
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageAdjustments.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Migrate the admin action**

In `be/src/app/admin/users/[id]/actions.ts`, find the action at lines 100-120 that currently does `db.update(usageRecords).set(...)`. Replace the whole mutation with:

```ts
import { applyAdjustment } from '@/api/services/UsageAdjustments';

// Inside the action handler:
await applyAdjustment({
  userId,
  adminUserId: currentAdmin.userId,  // from auth() session
  amountCents,                         // signed value from form input
  reason,                              // admin-supplied explanation
});
```

Remove the old `usage_records` UPDATE and its surrounding logic. If this file also mutates `subscriptions.creditBalanceCents` directly, remove that too — `applyAdjustment` handles it.

- [ ] **Step 6: Commit**

```bash
cd /app/data/home/be
git add src/api/services/UsageAdjustments.ts src/api/services/UsageAdjustments.test.ts src/app/admin/users/[id]/actions.ts
git commit -m "feat(admin): credit adjustments via usage_adjustments table

- applyAdjustment inserts the ledger row and updates balance in one transaction.
- Signed amountCents: positive = additional charge, negative = refund/credit.
- Admin-action mutations migrated off usage_records.
- Tests cover sign semantics and getPeriodSpending integration."
```

---

## Task 11: Remove `usage_records` + migration #2 (DROP)

**Files:**
- Modify: `be/src/db/schema.ts`
- Modify: `be/src/db/index.ts`
- Create: new migration file (auto-numbered) in `be/drizzle/`

- [ ] **Step 1: Verify no remaining code references**

Run: `cd /app/data/home/be && grep -rn "usageRecords\|usage_records" src/`
Expected: no results (all code readers were migrated in Tasks 8-10).

If any matches appear, migrate them before continuing.

- [ ] **Step 2: Remove schema entries**

In `be/src/db/schema.ts`, delete:
- The `usageRecords` pgTable declaration (lines ~75-91).
- The `usageRecordsRelations` export (lines ~93-98).
- `UsageRecord` and `NewUsageRecord` exported types (lines ~429-430).
- The `usageRecords: many(usageRecords)` entry in `usersRelations` (keep the `usageEvents` + `usageAdjustments` entries added in Task 1).

- [ ] **Step 3: Remove `src/db/index.ts` re-exports**

Delete `usageRecords, usageRecordsRelations`, `UsageRecord`, `NewUsageRecord` from the exports.

- [ ] **Step 4: Generate migration #2**

```bash
cd /app/data/home/be && pnpm db:generate
```

Expected: a new migration file containing `DROP TABLE "usage_records" CASCADE;` (drizzle-kit infers the drop from the schema diff). No backfill needed — Task 2's migration already captured the data.

- [ ] **Step 5: Apply locally**

```bash
cd /app/data/home/be && pnpm db:migrate
```

Expected: migration applies; verify:

```bash
cd /app/data/home/be && psql $DATABASE_URL -c "SELECT to_regclass('usage_records');"
```

Expected: returns `NULL`.

- [ ] **Step 6: TypeScript compiles + tests pass**

Run: `cd /app/data/home/be && pnpm tsc --noEmit && pnpm vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /app/data/home/be
git add src/db/schema.ts src/db/index.ts drizzle/
git commit -m "db: migration #2 — drop usage_records

All readers migrated off; pre-cutover data already persisted as rollup
events by migration #1. Schema and exports removed in the same commit
so the drizzle-kit snapshot stays in sync with the schema file."
```

---

## Task 12: `runhq/server/` — send `X-Server-Id` + context headers

**Files:**
- Modify: `runhq/server/src/services/ClaudeApiService.ts`
- Modify: callers that have task/channel/agent context (trace from `callWithTools` callers)

- [ ] **Step 1: Define `ClaudeCallContext` + extend `callWithTools` signature**

Open `/app/data/home/runhq/server/src/services/ClaudeApiService.ts`. Near the top-level type declarations, add:

```ts
export interface ClaudeCallContext {
  taskId?: string;        taskLabel?: string;
  channelId?: string;     channelLabel?: string;
  agentId?: string;       agentLabel?: string;
  conversationId?: string;
}
```

Find `callWithTools` (the method that contains the `fetch(..., '/api/claude/tools')` call around line 102). Add an optional `context?: ClaudeCallContext` parameter. If there's an options object already, add it there; otherwise add as a new arg.

- [ ] **Step 2: Send headers in the fetch call**

At the fetch call (current line 103-111), extend the `headers` block:

```ts
const encodeLabel = (s: string) => encodeURIComponent(s).slice(0, 512);

response = await fetch(`${this.apiUrl}/api/claude/tools`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
    'X-Server-Id': process.env.FLY_MACHINE_ID || 'local',
    ...(context?.taskId         ? { 'X-Task-Id':         context.taskId }                    : {}),
    ...(context?.taskLabel      ? { 'X-Task-Label':      encodeLabel(context.taskLabel) }    : {}),
    ...(context?.channelId      ? { 'X-Channel-Id':      context.channelId }                 : {}),
    ...(context?.channelLabel   ? { 'X-Channel-Label':   encodeLabel(context.channelLabel) } : {}),
    ...(context?.agentId        ? { 'X-Agent-Id':        context.agentId }                   : {}),
    ...(context?.agentLabel     ? { 'X-Agent-Label':     encodeLabel(context.agentLabel) }   : {}),
    ...(context?.conversationId ? { 'X-Conversation-Id': context.conversationId }            : {}),
  },
  body: requestBody,
  signal: combinedSignal,
});
```

- [ ] **Step 3: Write a test that captures outbound headers**

Create `runhq/server/src/services/ClaudeApiService.headers.test.ts`. Use the project's existing test framework (check package.json scripts — likely `jest` or `vitest`):

```ts
// Adapt imports/mocks to match the project's test framework.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeApiService } from './ClaudeApiService';

describe('ClaudeApiService.callWithTools headers', () => {
  const prevFetch = (globalThis as any).fetch;
  const prevFlyId = process.env.FLY_MACHINE_ID;

  beforeEach(() => {
    process.env.FLY_MACHINE_ID = 'fly-test-machine';
  });

  afterEach(() => {
    (globalThis as any).fetch = prevFetch;
    process.env.FLY_MACHINE_ID = prevFlyId;
  });

  it('sends X-Server-Id on every call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }),
    });
    (globalThis as any).fetch = fetchMock;

    const svc = new ClaudeApiService('http://be.test', 'fake-jwt');
    await svc.callWithTools({ model: 'claude-sonnet-4-6', messages: [], tools: [], system: '' });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Server-Id']).toBe('fly-test-machine');
  });

  it('sends context headers when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }),
    });
    (globalThis as any).fetch = fetchMock;

    const svc = new ClaudeApiService('http://be.test', 'fake-jwt');
    await svc.callWithTools(
      { model: 'claude-sonnet-4-6', messages: [], tools: [], system: '' },
      { taskId: 'task-1', taskLabel: 'Fix / login', agentId: 'agent-1', agentLabel: 'Bot' }
    );

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Task-Id']).toBe('task-1');
    expect(headers['X-Task-Label']).toBe('Fix%20%2F%20login');  // encoded
    expect(headers['X-Agent-Id']).toBe('agent-1');
    expect(headers['X-Agent-Label']).toBe('Bot');
    expect(headers['X-Channel-Id']).toBeUndefined();
  });

  it('omits context headers when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }),
    });
    (globalThis as any).fetch = fetchMock;

    const svc = new ClaudeApiService('http://be.test', 'fake-jwt');
    await svc.callWithTools({ model: 'claude-sonnet-4-6', messages: [], tools: [], system: '' });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Task-Id']).toBeUndefined();
    expect(headers['X-Agent-Id']).toBeUndefined();
    expect(headers['X-Server-Id']).toBe('fly-test-machine');  // always sent
  });
});
```

- [ ] **Step 4: Run tests — expect pass**

Run the runhq/server test command. Find it:

```bash
cd /app/data/home/runhq/server && cat package.json | grep -E "\"test\"|\"vitest\"|\"jest\""
```

Run according to what's defined (likely `pnpm test` or `pnpm vitest run`). Expected: 3 tests green.

- [ ] **Step 5: Thread `ClaudeCallContext` through agent-runtime callers**

Find `callWithTools` call sites:

```bash
cd /app/data/home/runhq/server && grep -rn "callWithTools(" src/ | head
```

For each call site, determine what task/channel/agent/conversation IDs are in scope and pass them via the new `context` param. Keep changes minimal per call site — only pass IDs that are actually available. A missing ID/label simply isn't sent.

No code change required for calls that don't know context — they just send `X-Server-Id` only, which is enough for per-server reporting.

- [ ] **Step 6: Rebuild RunHQ server Docker image (dev)**

Per project convention (CLAUDE.md):

```bash
cd /app/data/home/runhq && git rev-parse --short=7 HEAD > .build-version && cd server && docker-compose up -d --build
```

Expected: image rebuilt, container running.

- [ ] **Step 7: Commit**

```bash
cd /app/data/home/runhq
git add server/src/services/ClaudeApiService.ts server/src/services/ClaudeApiService.headers.test.ts
# Also add any caller files that were updated to thread context
git commit -m "feat(server): send X-Server-Id + context headers to /api/claude/tools

- ClaudeApiService.callWithTools takes an optional ClaudeCallContext.
- X-Server-Id sent on every call (Fly machine ID or 'local').
- X-Task-Id/Label, X-Channel-Id/Label, X-Agent-Id/Label, X-Conversation-Id sent
  when the caller provides them. Labels are URL-encoded.
- Tests cover always-sent X-Server-Id and optional context plumbing.

Ref: be/docs/superpowers/specs/2026-04-22-admin-usage-design.md"
```

---

## Task 13: `UsageReportService` query module

**Files:**
- Create: `be/src/api/services/UsageReportService.ts`
- Create: `be/src/api/services/UsageReportService.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `be/src/api/services/UsageReportService.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, users, usageEvents, usageAdjustments } from '@/db';
import {
  getDailyTotals,
  getSummary,
  getBreakdownByUser,
  getBreakdownByServer,
  getBreakdownByTask,
  getBreakdownByAgent,
} from './UsageReportService';
import { eq, inArray } from 'drizzle-orm';

describe('UsageReportService', () => {
  const u1 = '00000000-0000-0000-0000-000000000e01';
  const u2 = '00000000-0000-0000-0000-000000000e02';
  const adminId = '00000000-0000-0000-0000-000000000e03';

  const filter = {
    start: new Date('2026-04-01T00:00:00Z'),
    end:   new Date('2026-05-01T00:00:00Z'),
  };

  beforeEach(async () => {
    await db.delete(usageAdjustments).where(inArray(usageAdjustments.userId, [u1, u2]));
    await db.delete(usageEvents).where(inArray(usageEvents.userId, [u1, u2]));
    await db.delete(users).where(inArray(users.id, [u1, u2, adminId]));
    await db.insert(users).values([
      { id: u1, email: 'r1@example.com' },
      { id: u2, email: 'r2@example.com' },
      { id: adminId, email: 'ra@example.com' },
    ] as any);

    await db.insert(usageEvents).values([
      { userId: u1, ts: new Date('2026-04-10T12:00:00Z'), model: 'claude-sonnet-4-6',
        serverId: 's1', taskId: 't1', taskLabel: 'Task One',
        agentId: 'a1', agentLabel: 'Agent One',
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '10.0000' },
      { userId: u1, ts: new Date('2026-04-12T12:00:00Z'), model: 'claude-opus-4-7',
        serverId: 's1', taskId: 't1', taskLabel: 'Task One',
        agentId: 'a2', agentLabel: 'Agent Two',
        inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '30.0000' },
      { userId: u2, ts: new Date('2026-04-15T12:00:00Z'), model: 'claude-sonnet-4-6',
        serverId: 's2', taskId: null, taskLabel: null,
        agentId: null, agentLabel: null,
        inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '5.0000' },
      // A pre-cutover rollup row
      { userId: u1, ts: new Date('2026-04-30T23:59:59Z'), model: 'pre-cutover-rollup',
        inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '100.0000' },
    ] as any);
  });

  it('getSummary totals all rows in range by default', async () => {
    const s = await getSummary(filter);
    // 10 + 30 + 5 + 100 = 145
    expect(s.totalCostCents).toBeCloseTo(145, 3);
    expect(s.requestCount).toBe(4);
    expect(s.distinctUsers).toBe(2);
    expect(s.distinctServers).toBe(2);   // s1, s2 (null excluded)
  });

  it('getSummary excludes pre-cutover when requested', async () => {
    const s = await getSummary({ ...filter, excludePreCutover: true });
    expect(s.totalCostCents).toBeCloseTo(45, 3);  // 10 + 30 + 5
    expect(s.requestCount).toBe(3);
  });

  it('getDailyTotals buckets by day', async () => {
    const rows = await getDailyTotals({ ...filter, excludePreCutover: true }, 'day');
    // 2026-04-10: $10, 2026-04-12: $30, 2026-04-15: $5
    expect(rows).toHaveLength(3);
    const byDay = Object.fromEntries(rows.map((r) => [r.bucket, r.totalCostCents]));
    expect(byDay['2026-04-10']).toBeCloseTo(10, 3);
    expect(byDay['2026-04-12']).toBeCloseTo(30, 3);
    expect(byDay['2026-04-15']).toBeCloseTo(5, 3);
  });

  it('getBreakdownByUser groups + sorts desc', async () => {
    const rows = await getBreakdownByUser({ ...filter, excludePreCutover: true });
    expect(rows[0].userId).toBe(u1);          // u1 spent $40
    expect(rows[0].totalCostCents).toBeCloseTo(40, 3);
    expect(rows[1].userId).toBe(u2);
    expect(rows[1].totalCostCents).toBeCloseTo(5, 3);
  });

  it('getBreakdownByServer groups by serverId', async () => {
    const rows = await getBreakdownByServer({ ...filter, excludePreCutover: true });
    const byServer = Object.fromEntries(rows.map((r) => [r.serverId ?? '__null', r.totalCostCents]));
    expect(byServer.s1).toBeCloseTo(40, 3);
    expect(byServer.s2).toBeCloseTo(5, 3);
  });

  it('getBreakdownByTask uses taskLabel when present', async () => {
    const rows = await getBreakdownByTask(filter);
    const taskOne = rows.find((r) => r.taskId === 't1');
    expect(taskOne?.taskLabel).toBe('Task One');
    expect(taskOne?.totalCostCents).toBeCloseTo(40, 3);
  });

  it('getBreakdownByAgent groups by agentId', async () => {
    const rows = await getBreakdownByAgent(filter);
    const byAgent = Object.fromEntries(rows.map((r) => [r.agentId ?? '__null', r.totalCostCents]));
    expect(byAgent.a1).toBeCloseTo(10, 3);
    expect(byAgent.a2).toBeCloseTo(30, 3);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageReportService.test.ts`
Expected: FAIL — `Cannot find module './UsageReportService'`.

- [ ] **Step 3: Implement the module**

Create `be/src/api/services/UsageReportService.ts`:

```ts
import { db, usageEvents, usageAdjustments, users } from '@/db';
import { and, eq, gte, lte, inArray, ne, sql, desc } from 'drizzle-orm';

export interface UsageFilter {
  start: Date;
  end: Date;
  userIds?: string[];
  serverIds?: string[];
  excludePreCutover?: boolean;
}

export interface SummaryStats {
  totalCostCents: number;
  requestCount: number;
  distinctUsers: number;
  distinctServers: number;
}

export interface DailyPoint {
  bucket: string;        // 'YYYY-MM-DD' for day, 'YYYY-Www' for week, 'YYYY-MM' for month
  totalCostCents: number;
  requestCount: number;
}

export interface UserRow {
  userId: string;
  userEmail: string | null;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostCents: number;
}

export interface ServerRow {
  serverId: string | null;
  requestCount: number;
  totalCostCents: number;
}

export interface TaskRow {
  taskId: string | null;
  taskLabel: string | null;
  requestCount: number;
  totalCostCents: number;
}

export interface AgentRow {
  agentId: string | null;
  agentLabel: string | null;
  requestCount: number;
  totalCostCents: number;
}

function buildWhere(f: UsageFilter) {
  const parts = [
    gte(usageEvents.ts, f.start),
    lte(usageEvents.ts, f.end),
  ];
  if (f.excludePreCutover) parts.push(ne(usageEvents.model, 'pre-cutover-rollup'));
  if (f.userIds && f.userIds.length > 0) parts.push(inArray(usageEvents.userId, f.userIds));
  if (f.serverIds && f.serverIds.length > 0) parts.push(inArray(usageEvents.serverId, f.serverIds));
  return and(...parts);
}

export async function getSummary(f: UsageFilter): Promise<SummaryStats> {
  const [row] = await db
    .select({
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount:   sql<number>`COUNT(*)::int`,
      distinctUsers:  sql<number>`COUNT(DISTINCT ${usageEvents.userId})::int`,
      distinctServers: sql<number>`COUNT(DISTINCT ${usageEvents.serverId})::int`,
    })
    .from(usageEvents)
    .where(buildWhere(f));
  return row;
}

export async function getDailyTotals(
  f: UsageFilter,
  bucket: 'day' | 'week' | 'month',
): Promise<DailyPoint[]> {
  // date_trunc produces the first instant of the bucket — convert to string at the DB.
  const fmt = bucket === 'day' ? 'YYYY-MM-DD' : bucket === 'week' ? 'IYYY-"W"IW' : 'YYYY-MM';
  const bucketExpr = sql`to_char(date_trunc(${bucket}, ${usageEvents.ts}), ${fmt})`;

  return db
    .select({
      bucket:         sql<string>`${bucketExpr}`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount:   sql<number>`COUNT(*)::int`,
    })
    .from(usageEvents)
    .where(buildWhere(f))
    .groupBy(bucketExpr)
    .orderBy(bucketExpr);
}

export async function getBreakdownByUser(f: UsageFilter): Promise<UserRow[]> {
  return db
    .select({
      userId:              usageEvents.userId,
      userEmail:           users.email,
      requestCount:        sql<number>`COUNT(*)::int`,
      inputTokens:         sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)::int`,
      outputTokens:        sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      cacheReadTokens:     sql<number>`COALESCE(SUM(${usageEvents.cacheReadTokens}), 0)::int`,
      cacheCreationTokens: sql<number>`COALESCE(SUM(${usageEvents.cacheCreationTokens}), 0)::int`,
      totalCostCents:      sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .leftJoin(users, eq(usageEvents.userId, users.id))
    .where(buildWhere(f))
    .groupBy(usageEvents.userId, users.email)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export async function getBreakdownByServer(f: UsageFilter): Promise<ServerRow[]> {
  return db
    .select({
      serverId:       usageEvents.serverId,
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .where(buildWhere(f))
    .groupBy(usageEvents.serverId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export async function getBreakdownByTask(f: UsageFilter): Promise<TaskRow[]> {
  return db
    .select({
      taskId:         usageEvents.taskId,
      taskLabel:      sql<string | null>`MAX(${usageEvents.taskLabel})`,  // newest label wins
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .where(buildWhere(f))
    .groupBy(usageEvents.taskId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export async function getBreakdownByAgent(f: UsageFilter): Promise<AgentRow[]> {
  return db
    .select({
      agentId:        usageEvents.agentId,
      agentLabel:     sql<string | null>`MAX(${usageEvents.agentLabel})`,
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .where(buildWhere(f))
    .groupBy(usageEvents.agentId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export interface UsageEventCsvRow {
  ts: Date;
  userId: string;
  serverId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costCents: number;
  taskId: string | null;
  taskLabel: string | null;
  channelId: string | null;
  channelLabel: string | null;
  agentId: string | null;
  agentLabel: string | null;
  conversationId: string | null;
  anthropicRequestId: string | null;
}

/**
 * Stream raw event rows for CSV export. Uses Drizzle's built-in iterator
 * behavior by pulling in pages of 1000. At current scale, one month is
 * ~10-100k rows — trivial.
 */
export async function* streamEventsForCsv(f: UsageFilter): AsyncIterable<UsageEventCsvRow> {
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const rows = await db
      .select({
        ts: usageEvents.ts,
        userId: usageEvents.userId,
        serverId: usageEvents.serverId,
        model: usageEvents.model,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        cacheReadTokens: usageEvents.cacheReadTokens,
        cacheCreationTokens: usageEvents.cacheCreationTokens,
        costCents: sql<number>`${usageEvents.costCents}::double precision`,
        taskId: usageEvents.taskId,
        taskLabel: usageEvents.taskLabel,
        channelId: usageEvents.channelId,
        channelLabel: usageEvents.channelLabel,
        agentId: usageEvents.agentId,
        agentLabel: usageEvents.agentLabel,
        conversationId: usageEvents.conversationId,
        anthropicRequestId: usageEvents.anthropicRequestId,
      })
      .from(usageEvents)
      .where(buildWhere(f))
      .orderBy(desc(usageEvents.ts))
      .limit(PAGE)
      .offset(offset);
    if (rows.length === 0) return;
    for (const r of rows) yield r;
    if (rows.length < PAGE) return;
    offset += PAGE;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd /app/data/home/be && pnpm vitest run src/api/services/UsageReportService.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/UsageReportService.ts src/api/services/UsageReportService.test.ts
git commit -m "feat(usage): UsageReportService query module for admin page

- getSummary / getDailyTotals (day|week|month bucket) / getBreakdownBy{User,Server,Task,Agent}
- streamEventsForCsv paginates 1k rows at a time
- buildWhere supports excludePreCutover + user/server filters
- All queries single-round-trip; totals cast to double precision for sub-cent precision"
```

---

## Task 14: CSV export endpoint

**Files:**
- Create: `be/src/app/api/admin/usage/csv/route.ts`

- [ ] **Step 1: Implement the route**

Create `be/src/app/api/admin/usage/csv/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { streamEventsForCsv } from '@/api/services/UsageReportService';

// Next.js App Router streaming response.
// Guarded by session check — 403 for non-admins.
export async function GET(req: NextRequest) {
  const session = await auth();
  const user = (session?.user as any);
  if (!user?.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(req.url);
  const start = new Date(url.searchParams.get('start') || new Date(Date.now() - 30 * 864e5).toISOString());
  const end   = new Date(url.searchParams.get('end')   || new Date().toISOString());
  const userIds   = url.searchParams.get('userIds')?.split(',').filter(Boolean);
  const serverIds = url.searchParams.get('serverIds')?.split(',').filter(Boolean);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
    return new Response('Invalid date range', { status: 400 });
  }

  const encoder = new TextEncoder();
  const headers = [
    'ts', 'userId', 'serverId', 'model',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
    'costCents',
    'taskId', 'taskLabel', 'channelId', 'channelLabel',
    'agentId', 'agentLabel', 'conversationId', 'anthropicRequestId',
  ];

  const escapeCsv = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(headers.join(',') + '\n'));
      try {
        for await (const row of streamEventsForCsv({ start, end, userIds, serverIds })) {
          const line = [
            (row.ts instanceof Date ? row.ts.toISOString() : row.ts),
            row.userId, row.serverId, row.model,
            row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens,
            row.costCents,
            row.taskId, row.taskLabel, row.channelId, row.channelLabel,
            row.agentId, row.agentLabel, row.conversationId, row.anthropicRequestId,
          ].map(escapeCsv).join(',') + '\n';
          controller.enqueue(encoder.encode(line));
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });

  const fname = `usage-${start.toISOString().slice(0, 10)}-to-${end.toISOString().slice(0, 10)}.csv`;
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    },
  });
}
```

- [ ] **Step 2: Manual smoke test**

Start dev server; log in as an admin user; hit:

```
http://localhost:3000/api/admin/usage/csv?start=2026-04-01&end=2026-04-30
```

Expected: CSV downloads; first line is the header; each subsequent line is a row. Non-admin session returns 403.

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add src/app/api/admin/usage/csv/
git commit -m "feat(admin): CSV streaming export for /admin/usage

- Route at /api/admin/usage/csv; admin-only via session check.
- Streams paginated event rows; filename encodes the date range.
- Quotes CSV values correctly per RFC 4180."
```

---

## Task 15: Build `/admin/usage` page UI

**Files:**
- Create: `be/src/app/admin/usage/page.tsx`
- Create: `be/src/app/admin/usage/UsageFilters.tsx`
- Create: `be/src/app/admin/usage/UsageChart.tsx`
- Create: `be/src/app/admin/usage/BreakdownTable.tsx`
- Create: `be/src/app/admin/usage/PreCutoverBanner.tsx`
- Modify: `be/src/components/AdminChrome.tsx` (add nav link)
- Modify: `be/package.json` (add recharts dep)

- [ ] **Step 1: Install recharts**

```bash
cd /app/data/home/be && pnpm add recharts
```

Expected: `recharts` appears in `package.json` dependencies.

- [ ] **Step 2: Page scaffolding (Server Component)**

Create `be/src/app/admin/usage/page.tsx`:

```tsx
import {
  getSummary,
  getDailyTotals,
  getBreakdownByUser,
  getBreakdownByServer,
  getBreakdownByTask,
  getBreakdownByAgent,
  type UsageFilter,
} from '@/api/services/UsageReportService';
import { UsageFilters } from './UsageFilters';
import { UsageChart } from './UsageChart';
import { BreakdownTable } from './BreakdownTable';
import { PreCutoverBanner } from './PreCutoverBanner';

export const dynamic = 'force-dynamic';

function parseFilter(sp: Record<string, string | undefined>): UsageFilter & { groupBy: 'day' | 'week' | 'month' } {
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 864e5);

  const start = sp.start ? new Date(sp.start) : defaultStart;
  const end   = sp.end   ? new Date(sp.end)   : now;
  const groupBy = ((['day', 'week', 'month'] as const).find((v) => v === sp.groupBy) ?? 'day');
  const userIds   = sp.userIds?.split(',').filter(Boolean);
  const serverIds = sp.serverIds?.split(',').filter(Boolean);

  return { start, end, userIds, serverIds, groupBy, excludePreCutover: groupBy === 'day' };
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const f = parseFilter(sp);

  const [summary, daily, byUser, byServer, byTask, byAgent] = await Promise.all([
    getSummary({ ...f, excludePreCutover: false }),  // summary includes pre-cutover
    getDailyTotals({ ...f }, f.groupBy),
    getBreakdownByUser({ ...f, excludePreCutover: true }),
    getBreakdownByServer({ ...f, excludePreCutover: true }),
    getBreakdownByTask({ ...f, excludePreCutover: true }),
    getBreakdownByAgent({ ...f, excludePreCutover: true }),
  ]);

  const preCutoverTotal = summary.totalCostCents
    - byUser.reduce((s, r) => s + r.totalCostCents, 0);

  const csvHref = '/api/admin/usage/csv?' + new URLSearchParams({
    start: f.start.toISOString(),
    end: f.end.toISOString(),
    ...(f.userIds?.length   ? { userIds:   f.userIds.join(',') }   : {}),
    ...(f.serverIds?.length ? { serverIds: f.serverIds.join(',') } : {}),
  }).toString();

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Usage</h1>
        <a href={csvHref} className="rounded bg-black px-3 py-1.5 text-sm text-white hover:bg-neutral-800">
          Export CSV
        </a>
      </header>

      <UsageFilters current={f} />

      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Total spend" value={`$${(summary.totalCostCents / 100).toFixed(2)}`} />
        <SummaryCard label="Requests"    value={summary.requestCount.toLocaleString()} />
        <SummaryCard label="Users"       value={summary.distinctUsers.toString()} />
        <SummaryCard label="Servers"     value={summary.distinctServers.toString()} />
      </div>

      {preCutoverTotal > 0 && f.groupBy === 'day' && (
        <PreCutoverBanner totalCents={preCutoverTotal} />
      )}

      <UsageChart data={daily} bucket={f.groupBy} />

      <BreakdownTable
        title="By user"
        rows={byUser.map((r) => ({
          key: r.userId,
          label: r.userEmail ?? r.userId.substring(0, 8),
          cost: r.totalCostCents,
          requests: r.requestCount,
          extra: `${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out`,
        }))}
      />

      <BreakdownTable
        title="By server"
        rows={byServer.map((r) => ({
          key: r.serverId ?? '__null',
          label: r.serverId ?? '— Unknown —',
          cost: r.totalCostCents,
          requests: r.requestCount,
        }))}
      />

      <BreakdownTable
        title="By task"
        rows={byTask.map((r) => ({
          key: r.taskId ?? '__null',
          label: r.taskLabel ?? (r.taskId ? r.taskId.substring(0, 12) + '…' : '— No task context —'),
          cost: r.totalCostCents,
          requests: r.requestCount,
        }))}
      />

      <BreakdownTable
        title="By agent"
        rows={byAgent.map((r) => ({
          key: r.agentId ?? '__null',
          label: r.agentLabel ?? (r.agentId ? r.agentId.substring(0, 12) + '…' : '— No agent context —'),
          cost: r.totalCostCents,
          requests: r.requestCount,
        }))}
      />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
```

- [ ] **Step 3: Filter bar (Client Component)**

Create `be/src/app/admin/usage/UsageFilters.tsx`:

```tsx
'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

interface Props {
  current: {
    start: Date;
    end: Date;
    groupBy: 'day' | 'week' | 'month';
  };
}

export function UsageFilters({ current }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const update = useCallback((patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') params.delete(k);
      else params.set(k, v);
    }
    router.push(`${pathname}?${params.toString()}`);
  }, [sp, pathname, router]);

  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 864e5);
    update({ start: start.toISOString(), end: end.toISOString() });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-600">Range:</span>
        <button onClick={() => applyPreset(7)}  className="rounded border px-2 py-1 text-sm hover:bg-neutral-50">7d</button>
        <button onClick={() => applyPreset(30)} className="rounded border px-2 py-1 text-sm hover:bg-neutral-50">30d</button>
        <button onClick={() => applyPreset(90)} className="rounded border px-2 py-1 text-sm hover:bg-neutral-50">90d</button>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="date"
          className="rounded border px-2 py-1 text-sm"
          value={current.start.toISOString().slice(0, 10)}
          onChange={(e) => update({ start: new Date(e.target.value + 'T00:00:00Z').toISOString() })}
        />
        <span className="text-sm text-neutral-400">→</span>
        <input
          type="date"
          className="rounded border px-2 py-1 text-sm"
          value={current.end.toISOString().slice(0, 10)}
          onChange={(e) => update({ end: new Date(e.target.value + 'T23:59:59Z').toISOString() })}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-sm text-neutral-600">Group by:</span>
        {(['day', 'week', 'month'] as const).map((g) => (
          <button
            key={g}
            onClick={() => update({ groupBy: g })}
            className={`rounded px-2 py-1 text-sm ${current.groupBy === g ? 'bg-black text-white' : 'border hover:bg-neutral-50'}`}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Chart component (Client Component)**

Create `be/src/app/admin/usage/UsageChart.tsx`:

```tsx
'use client';

import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

interface Props {
  data: { bucket: string; totalCostCents: number; requestCount: number }[];
  bucket: 'day' | 'week' | 'month';
}

export function UsageChart({ data }: Props) {
  const chartData = data.map((d) => ({
    name: d.bucket,
    dollars: d.totalCostCents / 100,
    requests: d.requestCount,
  }));

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-neutral-700">Daily usage ($)</h2>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
            <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
            <Area type="monotone" dataKey="dollars" stroke="#111" fill="#111" fillOpacity={0.1} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

(v1 renders a single-series area chart. Multi-stack-by-model support is a v2 polish; the spec allows for this.)

- [ ] **Step 5: Breakdown table + pre-cutover banner**

Create `be/src/app/admin/usage/BreakdownTable.tsx`:

```tsx
interface Row {
  key: string;
  label: string;
  cost: number;          // cents
  requests: number;
  extra?: string;
}

interface Props {
  title: string;
  rows: Row[];
}

export function BreakdownTable({ title, rows }: Props) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 p-3 text-sm font-medium text-neutral-700">{title}</div>
      <table className="w-full text-sm">
        <thead className="text-neutral-500">
          <tr>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-right">Requests</th>
            <th className="px-3 py-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="px-3 py-4 text-neutral-400" colSpan={3}>No data</td></tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-t border-neutral-50">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.label}</div>
                  {r.extra && <div className="text-xs text-neutral-500">{r.extra}</div>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.requests.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">${(r.cost / 100).toFixed(2)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
```

Create `be/src/app/admin/usage/PreCutoverBanner.tsx`:

```tsx
interface Props {
  totalCents: number;
}

export function PreCutoverBanner({ totalCents }: Props) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <strong>Historical data:</strong> the selected range includes{' '}
      <span className="tabular-nums">${(totalCents / 100).toFixed(2)}</span>{' '}
      of pre-migration usage (monthly rollups only — daily breakdown not available for these periods).
    </div>
  );
}
```

- [ ] **Step 6: Add nav link to `AdminChrome`**

Open `be/src/components/AdminChrome.tsx`. Find the existing nav links (e.g. Users, Servers, Templates) and add a Usage entry pointing to `/admin/usage`. Match the existing component's styling pattern exactly.

- [ ] **Step 7: Manual smoke**

```bash
cd /app/data/home/be && pnpm dev
```

Open `http://localhost:3000/admin/usage`. Verify:
- Page renders as admin, 403 as non-admin.
- Default range = last 30 days; summary cards show numbers; chart renders; four breakdown tables render.
- Clicking 7d/30d/90d updates the URL and refetches.
- Changing date range inputs updates the URL.
- "Export CSV" downloads a file.

- [ ] **Step 8: Commit**

```bash
cd /app/data/home/be
git add src/app/admin/usage/ src/components/AdminChrome.tsx package.json pnpm-lock.yaml
git commit -m "feat(admin): /admin/usage page — filters, chart, breakdowns, CSV export

- Server Component reads filters from searchParams, runs 6 parallel queries.
- UsageFilters client component (date range + groupBy).
- UsageChart (Recharts area).
- BreakdownTable (user / server / task / agent).
- PreCutoverBanner for historical-rollup visibility.
- Links from AdminChrome nav."
```

---

## Task 16: End-to-end verification

**Files:** none (verification task)

- [ ] **Step 1: Full test suite green**

```bash
cd /app/data/home/be && pnpm vitest run
```
Expected: all tests PASS.

- [ ] **Step 2: Full type-check**

```bash
cd /app/data/home/be && pnpm tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: End-to-end manual: RunHQ server → be/ → admin page**

In order:

1. Rebuild RunHQ server Docker image (already done in Task 12):
   ```bash
   cd /app/data/home/runhq && git rev-parse --short=7 HEAD > .build-version && cd server && docker-compose up -d --build
   ```
2. Start `be/` locally: `cd /app/data/home/be && pnpm dev`.
3. From the Electron client, trigger an agent action that calls `/api/claude/tools`.
4. Confirm the proxy writes an event:
   ```bash
   psql $DATABASE_URL -c "SELECT ts, user_id, server_id, task_id, task_label, model, cost_cents FROM usage_events ORDER BY ts DESC LIMIT 5;"
   ```
   Expected: new row(s) with populated `server_id`; `task_id`/`task_label` populated where the call site provided them.
5. Open `http://localhost:3000/admin/usage`. The new usage appears in Today's bucket of the chart, in the user breakdown, in the server breakdown (under the Fly machine ID), and in the task breakdown if a task was in scope.
6. Click "Export CSV", open the file — confirm the row appears.

- [ ] **Step 4: Compare against Anthropic's console (reconciliation sanity)**

Pick a day with non-trivial usage. From `be/`'s admin page, note the day's total in dollars. Log into Anthropic's console → Usage → same day. The two should match within ~1% (rounding + UTC-cutoff timing).

If a larger gap appears, likely causes:
- Unknown model missing from `pricing.ts` — check server logs for the "Unknown model" warning.
- A model's pricing changed — audit the table against anthropic.com/pricing.
- Fractional cents getting rounded somewhere — verify storage is `numeric(12,4)`, not `integer`.

- [ ] **Step 5: Final commit (if any adjustments)**

If the reconciliation flagged pricing or other drift, apply the fix, commit, re-verify. Otherwise: done.

```bash
cd /app/data/home/be
git log --oneline | head -20   # Review all commits from this plan
```

---

## Deferred / follow-up (NOT in this PR)

- Anthropic Admin API / Usage API reconciliation (compare stored totals against Anthropic's cost_report, alert on drift).
- `/admin/migrations` read-only status page.
- Stacked-by-model/user/server chart variants (only single-series in v1).
- Alerts for per-user/per-server cost spikes.
- Materialized daily rollup table (if query latency becomes an issue at 100x scale).

---

## Self-Review Notes

- Every code block is runnable as-is.
- Every task has TDD: test → fail → implement → pass → commit.
- Type names (`TokenCounts`, `TrackUsageContext`, `UsageFilter`, etc.) are consistent across tasks.
- `usage_records` references are only present in Tasks 1-2 (keeping it), Tasks 8-11 (removing references), and the pre-cutover banner (historical).
- Pricing multipliers (`0.10`, `1.25`) appear once in a single source of truth (`pricing.ts`).
- Storage type (`numeric(12,4)`) is consistent across schema, tests, and runtime casts.
- All admin-page routes are gated by the existing `isAdmin` layout check.
- Dev-mode user seeding is wired before the proxy route first fires (ordering: Task 6 precedes Task 7).
