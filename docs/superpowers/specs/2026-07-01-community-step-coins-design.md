# Community Step-Coins — Design

**Task:** point system where ticket-creators and voters earn coin every time a ticket
advances a step in its lifecycle (`planned → in_progress → reviewed → merged → deployed`).
The coin total is displayed blatantly in the header of the widget modal, each post shows
how much coin the viewer earned from it, and hovering that per-post coin explains why.

**Date:** 2026-07-01
**Repos:** `be` only (widget + granting live entirely in `be`). The runhq task branch
(`ticket-686e0758`) carries the task ticket; the real PR is the `be` branch.

---

## 1. Context & what already exists

`be` has an unmerged branch `feat/community-channel-points` with a complete, well-built
points ledger that never shipped:

- **Migration** `src/db/migrations/2026-04-26-community-points.sql` — creates
  `point_grants` (append-only ledger, `idempotency_key UNIQUE`), `widget_user_balances`
  (CQRS projection with `balance`, `payouts_count`, `rank`), `widget_user_notifications`,
  and adds `widget_users.status` (`active`/`deleted`).
- **`CommunityPointsService`** — transactional core: idempotent grant insert +
  atomic balance upsert + rank recompute + notification insert, with post-commit pubsub.
- **`communityAwardingPolicy.ts`** — `isPayoutEligible` / `computePayoutAmount`
  (currently: creator-only, once, on terminal-success `done`/`deployed`, amount
  `10 + non-self upvotes`) + idempotency-key builders.
- **Awarding hook** in `WorkspaceTaskService.updateTask()` → `triggerCommunityAwarding()`,
  fired **post-commit, best-effort** (never rolls back the status write). This is the
  single canonical path — every task status change flows through `updateTask`.
- **Route** `GET /api/widget/me/community` — returns `{ rank, totalMembers, balance,
  payoutsCount, unreadNotificationCount }` for the calling widget user.

**Two gaps this branch has relative to the task:**

1. It is **60 commits behind master**, and its `workspaceTasks.status` type is missing
   `reviewed` and `merged` — the exact intermediate steps this task rewards. Master has
   the full `pending | planned | in_progress | done | reviewed | merged | cancelled |
   deployed | deployed:${string}` lifecycle. **A test merge of `origin/master` into this
   branch is clean (zero conflicts).**
2. Its awarding is **creator-only, once, on completion**. The task wants **creator AND
   every up-voter**, earning on **every step advance**.

The community branch's `public/widget.js` does **not** render any coin/rank UI (it was
dropped in the master merge), so the entire widget-facing display is fresh work.

### Design decisions (confirmed with user)

- **Reuse the ledger, extend the rules** — build on `point_grants` /
  `widget_user_balances` / `CommunityPointsService`; do not reinvent the ledger.
- **Fixed coin per step** = **1 coin** per tier crossed, to the creator and to each
  up-voter.
- **Replace** the old creator-only completion award with step-based awarding (the branch
  never shipped, so there is no production data to preserve; no double-awarding).
- **`be`-only** scope.

---

## 2. Base branch

Working branch `ticket-686e0758-community-coins` is cut from `feat/community-channel-points`.
**Step 0 of implementation: merge `origin/master`** (verified clean) so we get the
`reviewed`/`merged`/`deployed` lifecycle plus the latest widget/task code, on top of the
community ledger.

Leaderboard / staff-admin / notifications-bell UI from the community branch are **out of
scope** for this task and are left as-is (not extended, not removed).

---

## 3. Awarding rule — fixed coin per step, path-independent

### The ladder

An ordered ladder of rewardable tiers:

```
planned(0) → in_progress(1) → reviewed(2) → merged(3) → deployed(4)
```

- `deployed:${envId}` (deploy-to-env variant) normalizes to the `deployed` tier.
- `done` is a legacy synonym mapped to the `reviewed` tier (so tickets that use the older
  `done` status are not skipped).
- `pending`, `cancelled`, `needs_review` are **not** on the ladder (ordinal `-1`); a
  transition into them grants nothing.

### The rule

On a status transition `oldStatus → newStatus`, compute `oldOrdinal` and `newOrdinal`.
For **each tier `t` in `(oldOrdinal, newOrdinal]`** (i.e. every tier newly crossed going
forward), grant `STEP_COIN` (= **1**) to each eligible recipient, keyed idempotently by
`step:{ticketId}:{tierName}:{widgetUserId}`.

Properties:

- **Path-independent.** A jump `planned → merged` in one update pays `in_progress`,
  `reviewed`, `merged` (3 coin) — the same total as three separate transitions.
- **No double-pay.** Re-entering a tier (`merged → in_progress → merged`, or repeated
  `updateTask` with the same status) is a no-op because the tier's idempotency key already
  exists in `point_grants`.
- **Backward moves pay nothing** — the tier range `(oldOrdinal, newOrdinal]` is empty when
  `newOrdinal <= oldOrdinal`.

### Who earns, each tier

Resolved at award time from the ticket row:

- **Creator** — the widget user in `workspaceTasks.createdById`, **only** when
  `sourceType === 'widget'` (`createdById` is then a `widgetUsers.id`). Native/workspace
  creators earn no community coin.
- **Every current up-voter** — all `workspace_task_votes` rows for the ticket with
  `value = true` AND `voterType = 'external'`. Their `voterId` **is** a `widgetUsers.id`.
  Native (`member`) voters earn no community coin.

A user who is both creator and voter earns once per role per tier? No — earns **once per
tier** (deduplicate recipients by `widgetUserId`), with the reason preferring the creator
framing. Rationale: coin is per-tier-crossed, not per-role; a self-upvoting creator should
not double-dip.

Coin is community-scoped, so only widget users earn — consistent with the existing policy
that native RunHQ users don't receive community points.

### Amounts & reason text (for the tooltip)

- `amount = STEP_COIN = 1` per grant.
- `source = 'step_advance'` (new ledger source).
- `reason_code = 'creator_step'` or `'voter_step'`.
- `reason` = human string used verbatim by the hover tooltip, e.g.
  - creator: `"You submitted this and it reached Reviewed"`
  - voter: `"You upvoted this and it reached Merged"`
  - (tier label = title-cased tier name.)
- `metadata` = `{ tier, tierOrdinal, role }`.

---

## 4. Data model — reuse + one additive migration

Reuses `point_grants` and `widget_user_balances` unchanged. **One new migration**
`src/db/migrations/2026-07-01-point-grants-step-advance.sql`:

```sql
ALTER TABLE point_grants DROP CONSTRAINT point_grants_source_check;
ALTER TABLE point_grants ADD CONSTRAINT point_grants_source_check
  CHECK (source IN ('auto_completion','admin_grant','reversal','backfill','step_advance'));
```

(The Drizzle `$type` for `pointGrants.source` in `schema.ts` gains `'step_advance'` too.)

No new tables. Grants for a step advance write:
`(idempotency_key, project_id, widget_user_id, amount=1, source='step_advance',
reason, reason_code, ticket_id, metadata)`.

---

## 5. Service layer

### `communityAwardingPolicy.ts` (rewritten)

- `STEP_LADDER: readonly TierName[]` and `tierOrdinal(status): number` (handles
  `deployed:${env}` prefix and `done`→`reviewed`).
- `crossedTiers(oldStatus, newStatus): TierName[]` — the `(oldOrdinal, newOrdinal]`
  slice, `[]` for non-forward.
- `STEP_COIN = 1`.
- `stepAdvanceIdempotencyKey(ticketId, tier, widgetUserId): string` =
  `step:{ticketId}:{tier}:{widgetUserId}`.
- `stepReason(role, tier): string`.
- Existing `auto_completion` / `admin_grant` / `reversal` key builders retained (admin
  grant + reversal paths are untouched).

### `CommunityPointsService.awardForStepAdvance(event)` (new)

```
event = { ticketId, projectId, sourceType, createdWidgetUserId, oldStatus, newStatus }
```

1. `tiers = crossedTiers(oldStatus, newStatus)`; return `{ applied: false }` if empty or
   `sourceType !== 'widget'` or no `projectId`.
2. Resolve **recipients** (once): creator `widgetUserId` (if widget) + all external
   up-voter `widgetUserId`s for the ticket; dedupe, tag each with its role.
3. In a **single transaction**, for each `(recipient, tier)`:
   - idempotent `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` into `point_grants`;
   - if freshly inserted, upsert `widget_user_balances` (`balance += 1`); collect the set
     of touched users + deltas + `points.awarded` notification rows.
   - recompute project ranks **once** at the end (reusing the existing
     `recomputeProjectRanks` helper) if anything changed.
4. **Post-commit** (never inside the txn): publish `community_balance_changed` +
   `community_notification` per touched user, reusing existing pubsub topics/broadcaster.

`awardForCompletion` is **removed** (or left dormant and no longer called) — step-based
awarding supersedes it.

### `WorkspaceTaskService.triggerCommunityAwarding()` (rewired)

The captured `pendingAward = { row, oldStatus, newStatus }` and post-commit invocation are
unchanged. The body now:

- maps `sourceType` (`'widget'`/`'native'`),
- resolves `projectId` (via `widgetUsers.projectId` of the creator, with the existing
  `widgetProjects` by `serverId`+`channelId` fallback),
- calls `communityPointsService.awardForStepAdvance({...})`.

No longer needs `selfUpvoted` / `upvoteCountAtTransition` (those belonged to the old
completion formula). Still best-effort, still post-commit, still never rolls back the
status update.

---

## 6. Read API for the widget

### Extend `GET /api/widget/me/community`

Add a `coinByTicket` map to the existing response so a single fetch on panel open drives
both the header total (`balance`) and every per-post chip:

```jsonc
{
  "balance": 20, "rank": 3, "totalMembers": 250, ...,      // unchanged
  "coinByTicket": {
    "<ticketId>": { "coin": 3, "reasons": [
      "You upvoted this and it reached In progress",
      "You upvoted this and it reached Reviewed",
      "You upvoted this and it reached Merged"
    ] }
  }
}
```

Built from the caller's own `point_grants` where `source='step_advance'` and
`ticket_id IS NOT NULL`, grouped by `ticket_id`: `coin = SUM(amount)`, `reasons =`
each grant's `reason` ordered by tier ordinal. Scoped to `(project_id, widget_user_id)`;
naturally small per user.

---

## 7. Widget UI (`be/public/widget.js`, `.rw-` shadow-DOM styles)

Fetch `/api/widget/me/community` on panel open; cache as `communityStats`
(`{ balance, coinByTicket }`). All rendering is client-side.

- **Header total (blatant):** a coin badge in `.rw-list-topbar`, right of
  `.rw-list-title`, left of the absolute `.rw-shell-actions` (respect the 80px right pad).
  New `.rw-coin-total` class: coin glyph + formatted balance, e.g. `🪙 20`. Uses
  `--rw-accent`; visible in both themes.
- **Per-post chip:** in `renderTicketCard(ticket, opts)`, when
  `communityStats.coinByTicket[ticket.id]` exists, append a `.rw-coin-chip` to the card
  (e.g. `+3 🪙`). Only shown "if relevant" (viewer earned coin from that post).
- **Hover tooltip:** hovering `.rw-coin-chip` shows a small styled `.rw-coin-tip`
  positioned near the chip, listing the `reasons` (e.g. *"Because you upvoted this and it
  advanced to Merged"*). Styled to match the widget (not a native `title`), dismissed on
  mouseleave. Accessible: `tabindex`/`aria-label` fallback carrying the same text.
- **Live update:** subscribe (existing widget WS) to `community:widget_user:{id}` /
  `community:{projectId}` `community_balance_changed` for this user → refetch
  `/me/community` and re-render header + visible chips, so coin updates without reopening.

Number formatting via the widget's existing locale/`t()` conventions.

---

## 8. Testing

- **`communityAwardingPolicy` unit tests:** ordinal mapping (incl. `deployed:${env}`,
  `done`→`reviewed`, off-ladder statuses); `crossedTiers` for forward single-step, forward
  multi-step jumps, backward, same-tier, and into/out-of off-ladder statuses; idempotency
  key format stability.
- **`CommunityPointsService.awardForStepAdvance` tests:** creator+voters credited 1/tier;
  dedupe of creator-who-also-voted; idempotent replay (repeat call → no extra grants);
  multi-tier jump grants each crossed tier once; native-source / no-project → no-op;
  balance projection and rank recompute correct; pubsub fired post-commit only on fresh
  grants.
- **`WorkspaceTaskService` integration:** driving real `updateTask` status transitions
  produces the expected `point_grants` for creator + external voters and none for native
  actors; best-effort (awarding failure never rolls back the status write).
- **HTTP:** `/api/widget/me/community` returns correct `balance` + `coinByTicket`
  (grouping, reasons order, tenant scoping).

Follow the repo's Vitest conventions; migrations run via `scripts/run-migration.js`.

---

## 9. Out of scope

- Leaderboard UI, staff admin grant/reversal surfaces, notifications-bell/feed panel
  (exist on the community branch; not extended here).
- Surfacing coin in the runhq client.
- Coin redemption/spending, payouts.
- Native (non-widget) users earning coin.

---

## 10. Build sequence

1. Merge `origin/master` into the branch (verified clean).
2. Migration + `schema.ts` `source` `$type` add `'step_advance'`.
3. Rewrite `communityAwardingPolicy.ts` (ladder, `crossedTiers`, keys, reasons) + tests.
4. `CommunityPointsService.awardForStepAdvance` (+ remove/dormant `awardForCompletion`)
   + tests.
5. Rewire `triggerCommunityAwarding` + integration test.
6. Extend `/api/widget/me/community` with `coinByTicket` + test.
7. Widget UI: header total, per-post chip, hover tooltip, live update.
8. Run migration locally, apply-server-changes, manual widget verification.
