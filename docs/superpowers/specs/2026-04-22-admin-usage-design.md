---
title: Admin Usage Page — per-day, per-server, per-user credit usage
date: 2026-04-22
status: draft
author: brainstorm session (admin@runhq.io)
---

# Admin Usage Page

## Goal

Add a "Usage" section to the existing admin console (`be/src/app/admin/`) showing **daily credit usage in dollar amounts**, broken down by user, server, task, and agent. The primary success criterion: totals displayed on this page should match Anthropic's billing page within rounding.

## Motivation

The current billing/usage system tracks per-user monthly aggregates in `usage_records`. This is insufficient for two reasons:

1. **No daily granularity** — we cannot reconcile against Anthropic's per-day billing.
2. **No per-server / per-task / per-agent breakdown** — we cannot answer "which server / task / agent is driving spend?"

Additionally, the current `calculateCost` function prices only `input_tokens` and `output_tokens`, ignoring `cache_read_input_tokens` and `cache_creation_input_tokens`. Because the RunHQ server enables prompt caching (`cache_control: { type: 'ephemeral' }`), our stored `totalCostCents` already diverges from what Anthropic actually bills. Fixing this is a prerequisite for the "match Anthropic's billing" goal.

## Scope

### In scope

- New `usage_events` table — per-call event log, source of truth for Claude-call-driven spending.
- New `usage_adjustments` table — admin-driven balance corrections (grants, refunds, clawbacks), kept separate from events for clean audit boundaries.
- Remove `usage_records` table. Backfill historical monthly aggregates as one synthesized rollup event per (user, month) in `usage_events`.
- Rewrite `calculateCost` to price all four token kinds (input, output, cache-read, cache-creation-5m). Audit the per-model pricing table for missing current models (see Known Gaps).
- Propagate server and request context from RunHQ server to `be/` proxy via HTTP headers:
  - `X-Server-Id` — Fly machine ID
  - `X-Task-Id`, `X-Channel-Id`, `X-Agent-Id`, `X-Conversation-Id` — passed best-effort when the call site has them.
- Persist context on every event. Validate on the proxy side (length caps, UUID/opaque-string shape).
- Migrate the ~10 existing `usage_records` readers to query `usage_events` via a `getPeriodSpending()` helper.
- New admin page at `be/src/app/admin/usage/page.tsx` with filters, summary, daily chart, and breakdown tables (user, server, task, agent), plus CSV export.

### Out of scope (deferred)

- Anthropic Admin API / Usage API integration for automated reconciliation. The fixed pricing should make totals match within rounding; we verify manually against Anthropic's dashboard for one month. If drift persists, reconciliation is added in a follow-up.
- Read-only `/admin/migrations` status page (separate tool if wanted later).
- Auto-refresh or websocket updates on the admin page (static server-rendered report is sufficient).
- Per-user detail navigation from the usage page — clicking a user applies a filter, no separate route.

## Architecture

Three layers of change, in one PR that spans two repos (`be/` and `runhq/server/`):

### 1. `be/` (Next.js + Postgres, primary blast radius)

- Drizzle schema + migration: add `usage_events`, drop `usage_records`.
- `calculateCost` rewrite (cache-aware).
- `UsageService.trackUsage` rewrite: in one DB transaction, deduct `subscriptions.creditBalanceCents` AND insert `usage_events`. The `usage_records` read/write is removed.
- `getPeriodSpending(userId, startDate, endDate)` helper replaces all `usage_records` reader call sites.
- `POST /api/claude/tools` handler (`HttpServer.ts:675`) extracts new headers and passes them to `trackUsage`.
- Admin page at `src/app/admin/usage/page.tsx` (Server Component) with query helpers in `src/api/services/UsageReportService.ts`.

### 2. `runhq/server/` (Node/TypeScript, minimal change)

- `ClaudeApiService.callWithTools` (`src/services/ClaudeApiService.ts:102`) adds headers:
  - `X-Server-Id: ${process.env.FLY_MACHINE_ID || 'local'}`
  - `X-Task-Id`, `X-Channel-Id`, `X-Agent-Id`, `X-Conversation-Id` when provided by the caller.
- Call sites that invoke `callWithTools` pass the relevant IDs through the call chain. For agent runtime entry points, these are readily available in the execution context.

### 3. Data integrity boundary

- `subscriptions.creditBalanceCents` remains the atomic running balance for the credit-check hot path. **Unchanged.**
- `usage_events` is the ledger of **Claude-call-driven deductions** (one row per call).
- `usage_adjustments` is the ledger of **admin-driven balance changes** (grants, refunds, corrections). Separate table keeps `usage_events` pure.
- Everything else (monthly aggregates, per-user-per-period spend, admin views) is computed from these two tables.

Invariants (cleanly stated):

1. Every Claude call's deduction from `creditBalanceCents` has exactly one corresponding `usage_events` row, written in the same transaction as the deduction.
2. Every admin adjustment to `creditBalanceCents` has exactly one corresponding `usage_adjustments` row, same transaction.
3. Credit inflows (Stripe payments, plan grants, signup bonuses) are outside this ledger — they modify `creditBalanceCents` directly via their own code paths (Stripe webhook, plan-assignment flow). They are not "events" in the usage-reporting sense.

Thus period-spending queries SUM over `usage_events` + `usage_adjustments` (filtered by time range and user). "Credits remaining" is the current value of `creditBalanceCents`, not derived.

## Data Model

### New table: `usage_events`

```ts
// be/src/db/schema.ts
export const usageEvents = pgTable('usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  serverId: text('server_id'),            // Fly machine ID; null for local dev / legacy
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  model: text('model').notNull(),          // e.g. 'claude-opus-4-7', or 'pre-cutover-rollup'
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
  // numeric(12,4) preserves sub-cent precision from calculateCost without accumulating rounding drift.
  // Reads: Drizzle returns this as a string; cast to number in the query helper.
  costCents: numeric('cost_cents', { precision: 12, scale: 4 }).notNull().default('0'),
  // Context (all nullable — best-effort from RunHQ server)
  taskId: text('task_id'),
  taskLabel: text('task_label'),             // denormalized, frozen at insert time
  channelId: text('channel_id'),
  channelLabel: text('channel_label'),
  agentId: text('agent_id'),
  agentLabel: text('agent_label'),
  conversationId: text('conversation_id'),
  anthropicRequestId: text('anthropic_request_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const usageAdjustments = pgTable('usage_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  adminUserId: uuid('admin_user_id').references(() => users.id).notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  // Signed: negative = refund/credit, positive = additional charge/clawback.
  // numeric(12,4) for symmetry with usage_events.costCents.
  amountCents: numeric('amount_cents', { precision: 12, scale: 4 }).notNull(),
  reason: text('reason').notNull(),
});
```

Indexes (only what the admin queries require):

- `(ts DESC)` — range scans for the daily chart
- `(userId, ts DESC)` — per-user drill-down and `getPeriodSpending`
- `(serverId, ts DESC)` — per-server drill-down
- `(taskId)` — per-task aggregation (partial index `WHERE task_id IS NOT NULL`)
- `(agentId)` — per-agent aggregation (partial index `WHERE agent_id IS NOT NULL`)

No `anthropicRequestId` index until reconciliation is needed (YAGNI).

### Dropped: `usage_records`

- Table and Drizzle schema entry removed.
- `UsageRecord` / `NewUsageRecord` exported types removed.
- `usageRecordsRelations` removed.
- `users` relation `usageRecords: many(usageRecords)` replaced with `usageEvents: many(usageEvents)`.

### Backfill: pre-cutover rollup

As part of the Drizzle migration, after `usage_events` is created and before `usage_records` is dropped, insert one row per existing `usage_records` row:

```sql
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
  total_cost_cents,
  NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL
FROM usage_records;
```

The sentinel `model = 'pre-cutover-rollup'` makes these rows identifiable for UI filtering. `ts` is set to one second before the period's end, explicitly coerced to UTC (both source columns are `timestamp` without tz; UTC coercion is the only safe default). So the row falls inside the period it represents, regardless of how the UI buckets by day/week/month.

## Cost Calculation (Cache-Aware)

Rewrite `calculateCost` in `be/src/api/HttpServer.ts:4971`:

```ts
interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;   // 5-min ephemeral tier only (matches current cache_control usage)
}

function calculateCost(model: string, tokens: TokenCounts): number {
  const price = pricing[model] ?? pricing.default;

  const inputCents         = (tokens.inputTokens         / 1_000_000) * price.input          * 100;
  const outputCents        = (tokens.outputTokens        / 1_000_000) * price.output         * 100;
  const cacheReadCents     = (tokens.cacheReadTokens     / 1_000_000) * price.input * 0.10   * 100;
  const cacheCreationCents = (tokens.cacheCreationTokens / 1_000_000) * price.input * 1.25   * 100;

  return Math.round((inputCents + outputCents + cacheReadCents + cacheCreationCents) * 1000) / 1000;
}
```

**Multipliers**: Anthropic's published prompt cache pricing at spec time — `cache_read = 0.1 × input`, `cache_creation (5-min ephemeral) = 1.25 × input`. These are uniform across models where caching is supported. The 1-hour cache tier (2.0×) is not used by the RunHQ server today.

**Pricing table audit**: the current table (`HttpServer.ts:4973-4985`) is missing models likely in use, including `claude-opus-4-7` and any post-cutoff Sonnet/Haiku revisions. When a model is absent, the code falls back to `{ input: 3, output: 15 }` (Sonnet pricing) — which silently under-bills for Opus. As part of this PR, populate the table with every Claude 4.x model currently routable (Opus 4.6, 4.7; Sonnet 4.6; Haiku 4.5), and emit a warning log if an unknown model is seen. See Known Gaps.

**Second copy**: a parallel `calculateCostCents` exists in `be/src/api/services/UsageService.ts:128` used by `trackUsage`. Delete it — `trackUsage` will receive the already-computed `costCents` from the endpoint handler, eliminating the duplicate pricing path.

## Identity Propagation

### RunHQ server → proxy

In `runhq/server/src/services/ClaudeApiService.ts`, extend `callWithTools` (and any peer that calls `/api/claude/tools`) to accept a `context` parameter:

```ts
interface ClaudeCallContext {
  taskId?: string;        taskLabel?: string;     // e.g. task subject
  channelId?: string;     channelLabel?: string;  // e.g. channel name
  agentId?: string;       agentLabel?: string;    // e.g. agent display name
  conversationId?: string;
}
```

Labels are optional. If the call site knows the ID but not the label, send just the ID; the admin UI will fall back to showing the truncated ID. Labels are denormalized onto the event at insert time (not joined in at read time) because the entities live in a different database (RunHQ server's SQLite, per workspace) that `be/` cannot query. This also insulates historical reports against entity renames/deletions.

At fetch time (currently line 107):

```ts
// Labels are sent URL-encoded (RFC 8187 / encodeURIComponent). Proxy decodes before storing.
const encodeLabel = (s: string) => encodeURIComponent(s).slice(0, 512);

headers: {
  'Content-Type': 'application/json',
  ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
  'X-Server-Id': process.env.FLY_MACHINE_ID || 'local',
  ...(context?.taskId         ? { 'X-Task-Id':         context.taskId }         : {}),
  ...(context?.taskLabel      ? { 'X-Task-Label':      encodeLabel(context.taskLabel) }      : {}),
  ...(context?.channelId      ? { 'X-Channel-Id':      context.channelId }      : {}),
  ...(context?.channelLabel   ? { 'X-Channel-Label':   encodeLabel(context.channelLabel) }   : {}),
  ...(context?.agentId        ? { 'X-Agent-Id':        context.agentId }        : {}),
  ...(context?.agentLabel     ? { 'X-Agent-Label':     encodeLabel(context.agentLabel) }     : {}),
  ...(context?.conversationId ? { 'X-Conversation-Id': context.conversationId } : {}),
},
```

Context is threaded through the call chain from the agent runtime. Call sites that don't have a piece of context simply omit it (nullable server-side).

### Proxy header handling

In `be/src/api/HttpServer.ts` `POST /api/claude/tools` (line 675), after auth and before calling Anthropic, read and validate headers:

```ts
// Strict ID validation: opaque IDs are alphanumeric + [_-]. UUIDs, Fly machine IDs, and
// our own generated IDs all fit. Overly permissive regex is a silent-corruption risk.
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function readContextHeaders(c: Context) {
  const idOrNull = (s: string | undefined) =>
    (s && ID_PATTERN.test(s)) ? s : null;

  // Labels are encodeURIComponent-encoded by the sender; decode, then cap length.
  const labelOrNull = (s: string | undefined, max = 256): string | null => {
    if (!s) return null;
    try {
      const decoded = decodeURIComponent(s);
      return decoded.slice(0, max);
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

Pass the sanitized context to `trackUsage`, which stores it on the event row. Bad shapes are silently dropped (null) — never rejected. We don't break a Claude call because a header was malformed.

## UsageService Rewrite

### Before (`trackUsage`, existing)

1. `getOrCreateUsageRecord(userId, period)` — find or insert monthly row
2. Compute `costCents` via `calculateCostCents(input, output)` (ignores cache)
3. `UPDATE subscriptions SET creditBalanceCents = creditBalanceCents - costCents`
4. `UPDATE usage_records SET inputTokens += ..., outputTokens += ..., totalCostCents += costCents, requestCount += 1`

### After

Signature becomes:

```ts
async function trackUsage(
  userId: string,
  model: string,
  tokens: TokenCounts,
  costCents: number,                    // computed by caller (HttpServer)
  context: ContextHeaders,
  anthropicRequestId: string | null,
): Promise<void>
```

Inside one `db.transaction`:

1. `UPDATE subscriptions SET credit_balance_cents = credit_balance_cents - $costCents WHERE user_id = $userId`
2. `INSERT INTO usage_events (...) VALUES (...)`

No row reads, no aggregate updates, no separate cost recomputation.

### `getPeriodSpending` helper

```ts
// be/src/api/services/UsageService.ts
export async function getPeriodSpending(
  userId: string,
  start: Date,
  end: Date,
): Promise<{ inputTokens: number; outputTokens: number; totalCostCents: number; requestCount: number }> {
  const [row] = await db
    .select({
      inputTokens:  sql<number>`COALESCE(SUM(${usageEvents.inputTokens}),  0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
      // Drizzle returns numeric columns as strings; cast at query boundary.
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount: sql<number>`COUNT(*)`,
    })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.userId, userId),
      gte(usageEvents.ts, start),
      lte(usageEvents.ts, end),
    ));
  return row;
}
```

The helper sums BOTH `usage_events.costCents` AND `usage_adjustments.amountCents` for the period — so "period spending" correctly reflects both Claude calls and admin corrections. Implementation uses two subqueries UNION-ed, or two queries with results summed in application code; either is sub-millisecond at RunHQ's scale.

This replaces every `usageRecords.findFirst({ where: eq(userId) AND gte(periodStart) AND lte(periodEnd) })` and the derived `periodSpentCents` accessors. Call sites are:

- `UsageService.ts:294` (`getOrCreateUsageRecord` — deleted entirely)
- `UsageService.ts:414-421` (`getCreditBalance` — replaces `usageRecord.totalCostCents` with `getPeriodSpending(userId, periodStart, periodEnd).totalCostCents`)
- `UsageService.ts:501-506` (`getUsageHistory` — becomes `SELECT date_trunc('month', ts) AS period, SUM(...) FROM usage_events WHERE user_id = $1 AND ts BETWEEN $2 AND $3 GROUP BY period ORDER BY period`)
- `UsageService.ts:618-640` (internal balance helpers)
- `UsageService.ts:654-681` (internal balance helpers)
- `UsageService.ts:668-674` (plan-cap check)
- `src/app/admin/users/page.tsx:16-18` (admin users list, aggregate spend per user — rewritten as `SUM(costCents) GROUP BY userId`)
- `src/app/admin/users/[id]/page.tsx:37-43` (per-user detail page, current period)
- `src/app/admin/users/[id]/actions.ts:102-115` (admin-granted credit adjustments — these were mutations on `usage_records`. Rewrite: insert a row into the new `usage_adjustments` table (see Data Model) with `userId`, `adminUserId = current admin's userId`, `amountCents` (signed; negative = refund/credit, positive = additional charge/clawback), and `reason` (admin-supplied free text). In the same transaction, update `subscriptions.creditBalanceCents` by `-amountCents` (opposite sign to the adjustment itself, since a positive "charge more" reduces balance).)
- `src/app/admin/users/actions.ts:76` (user deletion cascade — now deletes from both `usage_events` and `usage_adjustments` where `userId = $id`)

## Admin Page

### Route

`be/src/app/admin/usage/page.tsx` — Server Component. Guarded by the existing `be/src/app/admin/layout.tsx` `isAdmin()` check. No new auth wiring.

### URL state

All filters are URL-driven (`searchParams`) so views are shareable and bookmarkable:

```
/admin/usage?start=2026-04-01&end=2026-04-22&groupBy=day&stackBy=model&userIds=a,b&serverIds=x,y
```

Defaults: last 30 days, `groupBy=day`, `stackBy=model`, no user/server filter.

### Layout (top to bottom)

1. **Filter bar** (sticky top)
   - Date range picker with presets: 7d / 30d / 90d / This month / Last month / Custom
   - Group-by toggle: Day (default) / Week / Month
   - User multi-select dropdown
   - Server multi-select dropdown

2. **Summary cards** (4-up row)
   - Total spend for selected range (`$X.XX`)
   - Total requests
   - Active users (distinct `userId`)
   - Active servers (distinct `serverId`, `pre-cutover-rollup` events excluded since serverId is null)

3. **Daily usage chart** (Recharts stacked area)
   - X axis: time bucket per `groupBy`
   - Y axis: dollars
   - Stacking controlled by `stackBy`: model (default) / user / server / none
   - **Pre-cutover banner**: if the selected range contains `model = 'pre-cutover-rollup'` events and `groupBy = 'day'`, show a banner listing the affected months and their totals; exclude these rows from the chart itself.

4. **Breakdown table — by user** — columns: user email, requests, input/output/cache-read/cache-write tokens, cost. Sort by cost desc.

5. **Breakdown table — by server** — same shape keyed by `serverId`. Rows with `serverId = NULL` grouped under "Unknown / pre-cutover".

6. **Breakdown table — by task** — rows where `taskId IS NOT NULL`, showing `taskLabel` (fallback: truncated `taskId` in monospace) + cost. Null-taskId rows aggregated into a single "No task context" summary row at the bottom.

7. **Breakdown table — by agent** — same pattern using `agentLabel` / `agentId`.

8. **CSV export button** — top-right of the breakdown section. Downloads the filtered raw event rows as CSV. Columns match the table columns plus `ts`, `model`, `anthropicRequestId`. Streamed to avoid memory spikes.

### Query module

All page queries live in `be/src/api/services/UsageReportService.ts`:

```ts
interface UsageFilter {
  start: Date;
  end: Date;
  userIds?: string[];
  serverIds?: string[];
  excludePreCutover?: boolean;   // for daily chart
}

export async function getDailyTotals(filter: UsageFilter, bucket: 'day' | 'week' | 'month'): Promise<DailyPoint[]>;
export async function getSummary(filter: UsageFilter): Promise<SummaryStats>;
export async function getBreakdownByUser(filter: UsageFilter): Promise<UserRow[]>;
export async function getBreakdownByServer(filter: UsageFilter): Promise<ServerRow[]>;
export async function getBreakdownByTask(filter: UsageFilter): Promise<TaskRow[]>;
export async function getBreakdownByAgent(filter: UsageFilter): Promise<AgentRow[]>;
export async function* streamEventsForCsv(filter: UsageFilter): AsyncIterable<UsageEventRow>;
```

Each is a single SQL query. `getDailyTotals` uses `date_trunc(bucket, ts)` for bucketing.

## Migration Strategy

One new Drizzle migration file under `be/drizzle/` (Drizzle auto-numbers the prefix):

1. `CREATE TABLE usage_events (...)` with indexes.
2. `INSERT INTO usage_events (...) SELECT ... FROM usage_records` (backfill).
3. `DROP TABLE usage_records`.

Steps 2 and 3 are in the same transaction as the rest of the migration — if backfill fails, the whole migration rolls back.

Deploy order:

1. Deploy `be/` with the migration. Old RunHQ servers (sending no `X-Server-Id`) will still work; events land with `server_id = NULL`.
2. Deploy `runhq/server/` with new headers. From here forward, events carry server and context IDs.

No dual-write / strangler phase needed — the entire reader migration is in the same PR as the schema change. The billing hot path (`creditBalanceCents` deduction) is unchanged.

## Testing

In `be/` (Vitest):

- `calculateCost.test.ts` — fixture-based: a table of `(model, token counts) → expected cents`, with numbers independently verified against Anthropic's pricing page (and against Anthropic's actual bill for a known recent test call if feasible).
- `UsageService.trackUsage.test.ts` — one test that inserts an event + deducts balance in a single transaction; one test that rolls back both if either fails.
- `UsageService.getPeriodSpending.test.ts` — seed events across a period, verify sums and counts match.
- `UsageReportService.test.ts` — seed varied events (including `usage_adjustments` rows); verify `getDailyTotals` buckets correctly, `getBreakdownByUser` aggregates across both tables, pre-cutover exclusion filter works, label-null fallback groups under "No task context" / "Unknown", CSV stream yields one row per event.
- `UsageAdjustments.test.ts` — insert an adjustment; verify `creditBalanceCents` moves by the correct signed amount in the same transaction; verify `getPeriodSpending` includes the adjustment in its sum.
- `UsageService.checkCreditBalance.test.ts` — the credit-check hot path still reads `subscriptions.creditBalanceCents` (unchanged logic); existing test cases should continue to pass after `periodSpentCents` is wired through `getPeriodSpending`.

In `runhq/server/` (framework TBD during planning — confirm existing test infra):

- `ClaudeApiService.headers.test.ts` — verify `X-Server-Id` is sent with the correct value; context headers sent when provided, omitted when absent. Mock `fetch` to capture outbound headers.

## Known Gaps (in-scope fixes)

1. **Pricing table missing models.** Audit and populate with every currently-routable Claude 4.x model. Add a runtime warning log when `calculateCost` receives an unknown model (silent fallback to Sonnet pricing today).
2. **Dev-mode auth bypass** (`HttpServer.ts:682-711`) — a request with no token in dev mode is allowed through and calls Anthropic without any `userId`. Resolution: seed a stable `'dev-local'` user (fixed UUID, e.g. `'00000000-0000-0000-0000-00000000dev0'`) on first server startup in non-prod environments; use that userId when the bypass fires. Skips nothing — dev traffic shows up in local reports labeled as the dev user. Prod unaffected.

## Deferred (follow-ups, not in this PR)

- **Anthropic Admin/Usage API reconciliation.** After one billing cycle of the new system, manually compare the admin page's monthly total against Anthropic's invoice. If within ~1%, no further work. Otherwise, add a nightly job that pulls Anthropic's `cost_report` and stores it alongside our totals for explicit drift monitoring.
- **Read-only `/admin/migrations` status page** (visibility into which Drizzle migrations are applied in prod).
- **Per-user detail page** enhancements using events (spark lines, recent call log).
- **Alerts** for cost spikes (per-user, per-server, per-agent).

## Open Questions

None at spec time. Raise any during plan review.

## Success Criteria

- Admin page at `/admin/usage` renders daily totals for the last 30 days (default stack: by model; server / user stacking available via the filter bar), with CSV export.
- One full billing cycle later, the page's total for that month matches the corresponding Anthropic invoice within ~1% (rounding + timing of the last hour of the period).
- `usage_records` no longer exists; no code references it.
- All `trackUsage` calls atomically insert an event + deduct balance, verified by tests.
- Pricing test fixture covers cache-read and cache-creation tokens for at least Opus, Sonnet, and Haiku.
