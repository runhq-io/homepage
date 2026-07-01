# Community Step-Coins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ticket creators and every external up-voter earn 1 community coin each time a widget ticket advances a lifecycle step (`planned → in_progress → reviewed → merged → deployed`), with the coin total shown blatantly in the widget modal header, a per-post earned-coin chip, and a hover tooltip explaining why.

**Architecture:** Reuse the existing (unmerged) `point_grants` ledger + `CommunityPointsService` transactional core. Replace the old creator-only completion award with a step-based award fired from the single canonical status-update hook (`WorkspaceTaskService.updateTask → triggerCommunityAwarding`). Extend `GET /api/widget/me/community` with a per-ticket earnings map; render header total + per-post chip + tooltip in the vanilla `public/widget.js` (shadow-DOM, `.rw-` styles).

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Hono HTTP, Vitest; vanilla JS widget in `public/widget.js`. Migrations = raw SQL in `src/db/migrations/*.sql` run by `scripts/run-migration.js` (NOT drizzle-kit).

## Global Constraints

- **Repo:** all work is in `be`, on branch `ticket-686e0758-community-coins` (cut from `feat/community-channel-points`). Verify with `git branch --show-current` before every commit.
- **STEP_COIN = 1** coin per tier crossed, per recipient.
- **Ladder (ordinals):** `planned`=0, `in_progress`=1, `reviewed`=2, `merged`=3, `deployed`=4. `deployed:${env}` → `deployed` tier. `done` → `reviewed` tier (ordinal 2). `pending`/`needs_review`/`cancelled` and anything else → ordinal `-1` (off-ladder, never rewarded).
- **Recipients** (widget-source tickets only): the creator (`workspaceTasks.createdById`, a `widgetUsers.id`) + every `workspace_task_votes` row for the ticket with `value=true AND voterType='external'` (`voterId` is a `widgetUsers.id`). Deduped by `widgetUserId`; a user present as both creator and voter earns once per tier, tagged `creator`.
- **Idempotency key:** `step:{ticketId}:{tier}:{widgetUserId}` (format is permanent once in prod — never change).
- **Ledger source value:** `'step_advance'`.
- **Awarding is best-effort & post-commit** — it must never roll back or block the authoritative status write (preserve the existing try/catch + `pendingAward` discipline).
- **Migration naming:** date-prefixed SQL, runs alphabetically; new file must sort AFTER `2026-04-26-community-points.sql`.
- **Widget styling:** shadow-DOM, `.rw-` class prefix, theme via `--rw-*` custom properties; use existing `t()`/locale helpers for any user-facing copy.

---

### Task 1: Rebase base branch onto current master

Brings in master's `reviewed`/`merged`/`deployed` lifecycle (the community branch predates it). Test-merge was verified clean (zero conflicts).

**Files:** none authored; merge commit only.

- [ ] **Step 1: Confirm branch**

Run: `cd /app/data/home/be-worktrees/ticket-686e0758-community-coins && git branch --show-current`
Expected: `ticket-686e0758-community-coins`

- [ ] **Step 2: Merge master**

Run:
```bash
git fetch origin -q
git merge --no-edit origin/master
```
Expected: `Merge made by the 'ort' strategy` with no `CONFLICT` lines.

- [ ] **Step 3: Verify lifecycle + ledger both present**

Run:
```bash
grep -n "'reviewed' | 'merged'" src/db/schema.ts | head -1
grep -n "export const pointGrants" src/db/schema.ts
```
Expected: first grep prints the `workspaceTasks.status` `$type` line containing `reviewed` and `merged`; second prints the `pointGrants` table declaration.

- [ ] **Step 4: Typecheck baseline**

Run: `pnpm -s tsc --noEmit`
Expected: exits 0 (record any pre-existing errors; there should be none).

---

### Task 2: Migration + schema — add `step_advance` ledger source

**Files:**
- Create: `src/db/migrations/2026-07-01-point-grants-step-advance.sql`
- Modify: `src/db/schema.ts` (the `pointGrants.source` `$type`, ~line 1538)

**Interfaces:**
- Produces: `point_grants.source` now accepts `'step_advance'`; Drizzle `$type` union includes `'step_advance'`.

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/2026-07-01-point-grants-step-advance.sql`:
```sql
-- Allow step-based awards in the point ledger.
-- Community step-coins grant one row per (ticket, tier, recipient); source = 'step_advance'.
ALTER TABLE point_grants DROP CONSTRAINT point_grants_source_check;

ALTER TABLE point_grants ADD CONSTRAINT point_grants_source_check
  CHECK (source IN ('auto_completion', 'admin_grant', 'reversal', 'backfill', 'step_advance'));
```

- [ ] **Step 2: Widen the Drizzle `$type`**

In `src/db/schema.ts`, change the `pointGrants.source` line from:
```ts
  source: text('source').$type<'auto_completion' | 'admin_grant' | 'reversal' | 'backfill'>().notNull(),
```
to:
```ts
  source: text('source').$type<'auto_completion' | 'admin_grant' | 'reversal' | 'backfill' | 'step_advance'>().notNull(),
```

- [ ] **Step 3: Apply the migration locally**

Run: `node scripts/run-migration.js`
Expected: log shows `2026-07-01-point-grants-step-advance` applied; no error.

- [ ] **Step 4: Verify the constraint**

Run:
```bash
psql "$DATABASE_URL" -c "\d+ point_grants" | grep source
```
Expected: the CHECK lists `step_advance`.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -s tsc --noEmit`
Expected: exits 0.
```bash
git add src/db/migrations/2026-07-01-point-grants-step-advance.sql src/db/schema.ts
git commit -m "feat(community): add step_advance source to point ledger"
```

---

### Task 3: Rewrite `communityAwardingPolicy` — ladder, crossed tiers, keys, reasons

Replaces the completion-only policy with the step ladder. Pure functions, fully unit-tested.

**Files:**
- Modify: `src/api/services/communityAwardingPolicy.ts`
- Test: `src/api/services/communityAwardingPolicy.test.ts` (already exists — replace its body)

**Interfaces:**
- Produces:
  - `type StepTier = 'in_progress' | 'reviewed' | 'merged' | 'deployed'`
  - `tierOrdinal(status: string): number` — `planned`→0, `in_progress`→1, `reviewed`→2 (`done` also →2), `merged`→3, `deployed`/`deployed:*`→4, else -1.
  - `crossedTiers(oldStatus: string, newStatus: string): StepTier[]` — the rewardable tiers in `(oldOrdinal, newOrdinal]`, forward-only, `[]` otherwise.
  - `STEP_COIN = 1`
  - `stepAdvanceIdempotencyKey(ticketId: string, tier: StepTier, widgetUserId: string): string`
  - `tierLabel(tier: StepTier): string` — `'In progress' | 'Reviewed' | 'Merged' | 'Deployed'`
  - `stepReason(role: 'creator' | 'voter', tier: StepTier): string`
- Retains: `adminGrantIdempotencyKey`, `reversalIdempotencyKey` (unchanged). `autoCompletionIdempotencyKey`, `isPayoutEligible`, `computePayoutAmount`, `TERMINAL_SUCCESS_STATUSES`, `StatusChangeEvent`, `backfillIdempotencyKey` are **removed** (Task 4/5 drop their only callers).

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/api/services/communityAwardingPolicy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  tierOrdinal,
  crossedTiers,
  STEP_COIN,
  stepAdvanceIdempotencyKey,
  tierLabel,
  stepReason,
} from './communityAwardingPolicy';

describe('tierOrdinal', () => {
  it('maps the ladder', () => {
    expect(tierOrdinal('planned')).toBe(0);
    expect(tierOrdinal('in_progress')).toBe(1);
    expect(tierOrdinal('reviewed')).toBe(2);
    expect(tierOrdinal('merged')).toBe(3);
    expect(tierOrdinal('deployed')).toBe(4);
  });
  it('treats done as the reviewed tier', () => {
    expect(tierOrdinal('done')).toBe(2);
  });
  it('normalizes deployed:<env> to the deployed tier', () => {
    expect(tierOrdinal('deployed:prod')).toBe(4);
    expect(tierOrdinal('deployed:staging-123')).toBe(4);
  });
  it('puts off-ladder statuses at -1', () => {
    expect(tierOrdinal('pending')).toBe(-1);
    expect(tierOrdinal('needs_review')).toBe(-1);
    expect(tierOrdinal('cancelled')).toBe(-1);
    expect(tierOrdinal('nonsense')).toBe(-1);
  });
});

describe('crossedTiers', () => {
  it('single forward step', () => {
    expect(crossedTiers('planned', 'in_progress')).toEqual(['in_progress']);
  });
  it('multi-step forward jump crosses every tier once, in order', () => {
    expect(crossedTiers('planned', 'merged')).toEqual(['in_progress', 'reviewed', 'merged']);
  });
  it('full run', () => {
    expect(crossedTiers('planned', 'deployed')).toEqual(['in_progress', 'reviewed', 'merged', 'deployed']);
  });
  it('backward transition rewards nothing', () => {
    expect(crossedTiers('merged', 'in_progress')).toEqual([]);
  });
  it('same-tier transition rewards nothing', () => {
    expect(crossedTiers('reviewed', 'reviewed')).toEqual([]);
    expect(crossedTiers('done', 'reviewed')).toEqual([]); // done == reviewed ordinal
  });
  it('coming from an off-ladder status counts from planned baseline', () => {
    // pending(-1) -> reviewed(2): crosses in_progress, reviewed (planned is ordinal 0, not rewardable itself)
    expect(crossedTiers('pending', 'reviewed')).toEqual(['in_progress', 'reviewed']);
  });
  it('into an off-ladder status rewards nothing', () => {
    expect(crossedTiers('merged', 'cancelled')).toEqual([]);
  });
});

describe('keys, labels, reasons', () => {
  it('STEP_COIN is 1', () => {
    expect(STEP_COIN).toBe(1);
  });
  it('idempotency key format is stable', () => {
    expect(stepAdvanceIdempotencyKey('t1', 'merged', 'u1')).toBe('step:t1:merged:u1');
  });
  it('tier labels are human', () => {
    expect(tierLabel('in_progress')).toBe('In progress');
    expect(tierLabel('deployed')).toBe('Deployed');
  });
  it('reasons read naturally', () => {
    expect(stepReason('creator', 'reviewed')).toBe('You submitted this and it reached Reviewed');
    expect(stepReason('voter', 'merged')).toBe('You upvoted this and it reached Merged');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm -s vitest run src/api/services/communityAwardingPolicy.test.ts`
Expected: FAIL (imports not defined / old exports gone).

- [ ] **Step 3: Rewrite the policy module**

Replace the contents of `src/api/services/communityAwardingPolicy.ts`:
```ts
/**
 * Community step-coins awarding policy (pure functions).
 *
 * Ticket creators and external up-voters earn 1 coin each time a widget ticket
 * advances a rewardable lifecycle tier. This module owns the ladder, the
 * "which tiers did this transition cross" logic, and the stable idempotency-key
 * and reason strings. No I/O.
 */

/** Rewardable tiers, in ascending order. `planned` is the baseline (ordinal 0, not itself rewarded). */
export type StepTier = 'in_progress' | 'reviewed' | 'merged' | 'deployed';

const LADDER: readonly StepTier[] = ['in_progress', 'reviewed', 'merged', 'deployed'];

/** STEP_COIN — fixed coin granted per crossed tier, per recipient. */
export const STEP_COIN = 1;

/**
 * Ordinal of a status on the lifecycle ladder.
 *   planned=0, in_progress=1, reviewed=2, merged=3, deployed=4.
 * `done` is a legacy synonym for the reviewed tier (2).
 * `deployed:<env>` normalizes to deployed (4).
 * Everything off-ladder (pending, needs_review, cancelled, unknown) is -1.
 */
export function tierOrdinal(status: string): number {
  if (status === 'deployed' || status.startsWith('deployed:')) return 4;
  switch (status) {
    case 'planned': return 0;
    case 'in_progress': return 1;
    case 'reviewed': return 2;
    case 'done': return 2;
    case 'merged': return 3;
    default: return -1;
  }
}

/**
 * The rewardable tiers a transition crosses, forward-only.
 * Returns the tiers whose ordinal is in (oldOrdinal, newOrdinal], in ascending order.
 * Off-ladder old status is treated as the `planned` baseline (0) so a jump from
 * e.g. pending → reviewed still rewards in_progress + reviewed. Backward or
 * same-tier transitions, and transitions into off-ladder statuses, reward nothing.
 */
export function crossedTiers(oldStatus: string, newStatus: string): StepTier[] {
  const newOrd = tierOrdinal(newStatus);
  if (newOrd < 1) return []; // into off-ladder or into `planned` — nothing rewardable
  const rawOld = tierOrdinal(oldStatus);
  const oldOrd = rawOld < 0 ? 0 : rawOld; // off-ladder start counts from planned baseline
  if (newOrd <= oldOrd) return [];
  // LADDER[i] has ordinal i+1; include tiers with ordinal in (oldOrd, newOrd].
  return LADDER.filter((_, i) => {
    const ord = i + 1;
    return ord > oldOrd && ord <= newOrd;
  });
}

/**
 * Idempotency key for one (ticket, tier, recipient) award. Persisted in
 * point_grants.idempotency_key (UNIQUE). Format is permanent once in prod.
 */
export function stepAdvanceIdempotencyKey(ticketId: string, tier: StepTier, widgetUserId: string): string {
  return `step:${ticketId}:${tier}:${widgetUserId}`;
}

/** Human, sentence-case label for a tier. */
export function tierLabel(tier: StepTier): string {
  switch (tier) {
    case 'in_progress': return 'In progress';
    case 'reviewed': return 'Reviewed';
    case 'merged': return 'Merged';
    case 'deployed': return 'Deployed';
  }
}

/** User-facing reason stored on the grant and shown in the hover tooltip. */
export function stepReason(role: 'creator' | 'voter', tier: StepTier): string {
  const verb = role === 'creator' ? 'submitted' : 'upvoted';
  return `You ${verb} this and it reached ${tierLabel(tier)}`;
}

// Admin-grant / reversal idempotency keys are unchanged from the ledger design.
export function adminGrantIdempotencyKey(clientRequestId: string): string {
  return `admin_grant:${clientRequestId}`;
}
export function reversalIdempotencyKey(originalGrantId: string): string {
  return `reversal:${originalGrantId}`;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm -s vitest run src/api/services/communityAwardingPolicy.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/api/services/communityAwardingPolicy.ts src/api/services/communityAwardingPolicy.test.ts
git commit -m "feat(community): step-ladder awarding policy (crossedTiers, reasons, keys)"
```

---

### Task 4: `CommunityPointsService.awardForStepAdvance` (+ retire `awardForCompletion`)

Grants coin to creator + external voters for every crossed tier, in one transaction, idempotently, with post-commit pubsub. Reuses the existing balance-upsert + `recomputeProjectRanks` + notification machinery.

**Files:**
- Modify: `src/api/services/CommunityPointsService.ts`
- Test: `src/api/services/CommunityPointsService.test.ts` (add a describe block; keep existing grantBonus/reverseGrant tests)

**Interfaces:**
- Consumes: `crossedTiers`, `STEP_COIN`, `stepAdvanceIdempotencyKey`, `stepReason` (Task 3); `pointGrants`, `widgetUserBalances`, `widgetUserNotifications`, `widgetUsers`, `workspaceTaskVotes` (schema); existing `recomputeProjectRanks` helper.
- Produces:
  - `interface StepAdvanceEvent { ticketId: string; projectId: string; sourceType: 'native' | 'widget'; creatorWidgetUserId: string | null; oldStatus: string; newStatus: string; }`
  - `awardForStepAdvance(event: StepAdvanceEvent): Promise<{ applied: boolean; grantsCreated: number }>`

- [ ] **Step 1: Write the failing tests**

Add to `src/api/services/CommunityPointsService.test.ts` (follow the file's existing in-memory/pg test harness pattern — mirror how `grantBonus` tests set up `db`, seed `widget_projects` + `widget_users`, and assert on `point_grants` / `widget_user_balances`):
```ts
describe('awardForStepAdvance', () => {
  // Assumes helpers from the existing suite: makeService(), seedProject(), seedWidgetUser(),
  // seedTicket(), seedExternalVote(). If absent, add them mirroring the grantBonus setup.

  it('grants 1 coin per crossed tier to creator and each external voter', async () => {
    const { svc, db, projectId } = await makeService();
    const creator = await seedWidgetUser(db, projectId);
    const voterA = await seedWidgetUser(db, projectId);
    const voterB = await seedWidgetUser(db, projectId);
    const ticketId = await seedTicket(db, { createdById: creator.id, sourceType: 'widget' });
    await seedExternalVote(db, ticketId, voterA.id);
    await seedExternalVote(db, ticketId, voterB.id);

    const res = await svc.awardForStepAdvance({
      ticketId, projectId, sourceType: 'widget',
      creatorWidgetUserId: creator.id, oldStatus: 'planned', newStatus: 'reviewed',
    });

    // 2 crossed tiers (in_progress, reviewed) x 3 recipients = 6 grants; each balance += 2.
    expect(res.applied).toBe(true);
    expect(res.grantsCreated).toBe(6);
    for (const u of [creator, voterA, voterB]) {
      const [bal] = await db.select().from(widgetUserBalances).where(eq(widgetUserBalances.widgetUserId, u.id));
      expect(bal.balance).toBe(2);
    }
  });

  it('is idempotent: replaying the same transition creates no new grants', async () => {
    const { svc, db, projectId } = await makeService();
    const creator = await seedWidgetUser(db, projectId);
    const ticketId = await seedTicket(db, { createdById: creator.id, sourceType: 'widget' });
    const ev = { ticketId, projectId, sourceType: 'widget' as const, creatorWidgetUserId: creator.id, oldStatus: 'planned', newStatus: 'in_progress' };
    const first = await svc.awardForStepAdvance(ev);
    const second = await svc.awardForStepAdvance(ev);
    expect(first.grantsCreated).toBe(1);
    expect(second.grantsCreated).toBe(0);
    const [bal] = await db.select().from(widgetUserBalances).where(eq(widgetUserBalances.widgetUserId, creator.id));
    expect(bal.balance).toBe(1);
  });

  it('a creator who also upvoted earns once per tier (deduped, tagged creator)', async () => {
    const { svc, db, projectId } = await makeService();
    const creator = await seedWidgetUser(db, projectId);
    const ticketId = await seedTicket(db, { createdById: creator.id, sourceType: 'widget' });
    await seedExternalVote(db, ticketId, creator.id); // self-upvote
    const res = await svc.awardForStepAdvance({
      ticketId, projectId, sourceType: 'widget', creatorWidgetUserId: creator.id,
      oldStatus: 'planned', newStatus: 'in_progress',
    });
    expect(res.grantsCreated).toBe(1);
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.widgetUserId, creator.id));
    expect(grants).toHaveLength(1);
    expect(grants[0].reasonCode).toBe('creator_step');
  });

  it('native-source or missing project is a no-op', async () => {
    const { svc } = await makeService();
    const res = await svc.awardForStepAdvance({
      ticketId: 'x', projectId: '', sourceType: 'native',
      creatorWidgetUserId: null, oldStatus: 'planned', newStatus: 'deployed',
    });
    expect(res.applied).toBe(false);
    expect(res.grantsCreated).toBe(0);
  });

  it('backward transition grants nothing', async () => {
    const { svc, db, projectId } = await makeService();
    const creator = await seedWidgetUser(db, projectId);
    const ticketId = await seedTicket(db, { createdById: creator.id, sourceType: 'widget' });
    const res = await svc.awardForStepAdvance({
      ticketId, projectId, sourceType: 'widget', creatorWidgetUserId: creator.id,
      oldStatus: 'merged', newStatus: 'in_progress',
    });
    expect(res.applied).toBe(false);
    expect(res.grantsCreated).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm -s vitest run src/api/services/CommunityPointsService.test.ts -t awardForStepAdvance`
Expected: FAIL (`awardForStepAdvance` not a function).

- [ ] **Step 3: Implement `awardForStepAdvance`**

In `src/api/services/CommunityPointsService.ts`:

(a) Update imports — drop the removed policy symbols, add the new ones and `workspaceTaskVotes`:
```ts
import {
  crossedTiers,
  STEP_COIN,
  stepAdvanceIdempotencyKey,
  stepReason,
  adminGrantIdempotencyKey,
  reversalIdempotencyKey,
} from './communityAwardingPolicy';
```
Add `workspaceTaskVotes` to the `../../db/schema` import group.

(b) Add the event type near the other return/param types:
```ts
export interface StepAdvanceEvent {
  ticketId: string;
  projectId: string;
  sourceType: 'native' | 'widget';
  creatorWidgetUserId: string | null;
  oldStatus: string;
  newStatus: string;
}
```

(c) Add the method to the class (place it where `awardForCompletion` was; **delete `awardForCompletion`**):
```ts
/**
 * Grants STEP_COIN to the creator and every external up-voter for each lifecycle
 * tier this transition crosses. Idempotent per (ticket, tier, widgetUser).
 * Widget-source tickets only; native/no-project transitions are a no-op.
 */
async awardForStepAdvance(event: StepAdvanceEvent): Promise<{ applied: boolean; grantsCreated: number }> {
  const tiers = crossedTiers(event.oldStatus, event.newStatus);
  if (tiers.length === 0) return { applied: false, grantsCreated: 0 };
  if (event.sourceType !== 'widget' || !event.projectId) return { applied: false, grantsCreated: 0 };

  // Resolve recipients: creator (tagged 'creator') + external up-voters (tagged 'voter'),
  // deduped by widgetUserId with creator taking precedence.
  const roleByUser = new Map<string, 'creator' | 'voter'>();
  if (event.creatorWidgetUserId) roleByUser.set(event.creatorWidgetUserId, 'creator');
  const voters = await this.db
    .select({ voterId: workspaceTaskVotes.voterId })
    .from(workspaceTaskVotes)
    .where(and(
      eq(workspaceTaskVotes.taskId, event.ticketId),
      eq(workspaceTaskVotes.voterType, 'external'),
      eq(workspaceTaskVotes.value, true),
    ));
  for (const v of voters) {
    if (v.voterId && !roleByUser.has(v.voterId)) roleByUser.set(v.voterId, 'voter');
  }
  if (roleByUser.size === 0) return { applied: false, grantsCreated: 0 };

  const now = this.now();
  const touched: Array<{ widgetUserId: string; oldBalance: number; newBalance: number; oldRank: number | null; newRank: number | null; notificationId: string | null }> = [];
  let grantsCreated = 0;

  await this.db.transaction(async (tx) => {
    for (const [widgetUserId, role] of roleByUser) {
      let userDelta = 0;
      let oldBalance = 0;
      let oldRank: number | null = null;
      let notificationId: string | null = null;
      let lastGrantId: string | null = null;

      for (const tier of tiers) {
        const [inserted] = await tx
          .insert(pointGrants)
          .values({
            projectId: event.projectId,
            widgetUserId,
            amount: STEP_COIN,
            source: 'step_advance',
            idempotencyKey: stepAdvanceIdempotencyKey(event.ticketId, tier, widgetUserId),
            ticketId: event.ticketId,
            reason: stepReason(role, tier),
            reasonCode: `${role}_step`,
            metadata: { tier, role },
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          userDelta += STEP_COIN;
          grantsCreated += 1;
          lastGrantId = inserted.id;
        }
      }

      if (userDelta === 0) continue; // fully idempotent for this user

      const [existingBalance] = await tx
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, widgetUserId));
      oldBalance = existingBalance?.balance ?? 0;
      oldRank = existingBalance?.rank ?? null;

      const [updated] = await tx
        .insert(widgetUserBalances)
        .values({ widgetUserId, projectId: event.projectId, balance: userDelta, payoutsCount: 1, lastPayoutAt: now, rank: null })
        .onConflictDoUpdate({
          target: widgetUserBalances.widgetUserId,
          set: {
            balance: sql`${widgetUserBalances.balance} + ${userDelta}`,
            payoutsCount: sql`${widgetUserBalances.payoutsCount} + 1`,
            lastPayoutAt: now,
          },
        })
        .returning();

      const [notif] = await tx
        .insert(widgetUserNotifications)
        .values({
          widgetUserId,
          projectId: event.projectId,
          type: 'points.awarded',
          payload: { ticketId: event.ticketId, amount: userDelta, grantId: lastGrantId, oldBalance, newBalance: updated!.balance },
        })
        .returning({ id: widgetUserNotifications.id });
      notificationId = notif!.id;

      touched.push({ widgetUserId, oldBalance, newBalance: updated!.balance, oldRank, newRank: null, notificationId });
    }

    if (touched.length > 0) {
      await recomputeProjectRanks(tx, event.projectId);
      for (const t of touched) {
        const [r] = await tx.select({ rank: widgetUserBalances.rank }).from(widgetUserBalances).where(eq(widgetUserBalances.widgetUserId, t.widgetUserId));
        t.newRank = r?.rank ?? null;
      }
    }
  });

  // Post-commit pubsub — never inside the transaction.
  for (const t of touched) {
    this.publish(`community:${event.projectId}`, {
      type: 'community_balance_changed',
      projectId: event.projectId,
      widgetUserId: t.widgetUserId,
      oldBalance: t.oldBalance,
      newBalance: t.newBalance,
      oldRank: t.oldRank,
      newRank: t.newRank,
      grantId: t.notificationId ?? '',
    });
    if (t.notificationId) {
      this.publish(`community:widget_user:${t.widgetUserId}`, {
        type: 'community_notification',
        projectId: event.projectId,
        widgetUserId: t.widgetUserId,
        notificationId: t.notificationId,
      });
    }
  }

  return { applied: grantsCreated > 0, grantsCreated };
}
```

Note: delete the now-unused `awardForCompletion` method and its `AwardResult` type if nothing else references them (Task 5 removes the caller). Keep `grantBonus` and `reverseGrant` untouched.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm -s vitest run src/api/services/CommunityPointsService.test.ts`
Expected: PASS (new `awardForStepAdvance` block + existing grantBonus/reverseGrant).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -s tsc --noEmit`
Expected: exits 0.
```bash
git add src/api/services/CommunityPointsService.ts src/api/services/CommunityPointsService.test.ts
git commit -m "feat(community): awardForStepAdvance grants creator + voters per crossed tier"
```

---

### Task 5: Rewire `triggerCommunityAwarding` to call `awardForStepAdvance`

**Files:**
- Modify: `src/api/services/WorkspaceTaskService.ts` (the `triggerCommunityAwarding` function ~lines 690-770, and its call site)
- Test: `src/api/services/WorkspaceTaskService.community-awarding.test.ts` (update expectations to step-based)

**Interfaces:**
- Consumes: `communityPointsService.awardForStepAdvance` (Task 4). Keeps the existing `pendingAward = { row, oldStatus, newStatus }` capture and post-commit best-effort invocation.

- [ ] **Step 1: Update the integration test**

In `src/api/services/WorkspaceTaskService.community-awarding.test.ts`, replace completion-era assertions so that: a widget-source ticket with an external voter, transitioned `planned → reviewed` via `updateTask`, yields `point_grants` rows `source='step_advance'` for both creator and voter across tiers `in_progress` + `reviewed` (creator: 2 rows, voter: 2 rows); a native-source ticket yields none; an awarding failure (e.g. stub `awardForStepAdvance` to throw) does NOT roll back the status write (the row's status is still updated). Mirror the file's existing harness for constructing `db`, seeding a widget project/user/ticket/vote, and invoking `updateTask`.

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm -s vitest run src/api/services/WorkspaceTaskService.community-awarding.test.ts`
Expected: FAIL (still expects completion award / new source not produced).

- [ ] **Step 3: Rewrite `triggerCommunityAwarding`**

Replace the body of `triggerCommunityAwarding` in `src/api/services/WorkspaceTaskService.ts`:
```ts
async function triggerCommunityAwarding(
  row: WorkspaceTask,
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  const sourceType: 'native' | 'widget' = row.sourceType === 'widget' ? 'widget' : 'native';
  if (sourceType !== 'widget') return;

  // Resolve project + creator widgetUserId. For widget tasks createdById is a widgetUsers.id.
  let projectId: string | null = null;
  let creatorWidgetUserId: string | null = null;
  if (row.createdById) {
    const [widgetUser] = await db
      .select({ id: widgetUsers.id, projectId: widgetUsers.projectId })
      .from(widgetUsers)
      .where(eq(widgetUsers.id, row.createdById))
      .limit(1);
    if (widgetUser) {
      creatorWidgetUserId = widgetUser.id;
      projectId = widgetUser.projectId;
    }
  }
  // Fallback: derive project from serverId (+ channelId) when the creator link is missing.
  if (!projectId) {
    const conditions = [eq(widgetProjects.serverId, row.serverId)];
    if (row.workspaceChannelId) conditions.push(eq(widgetProjects.channelId, row.workspaceChannelId));
    const [project] = await db.select({ id: widgetProjects.id }).from(widgetProjects).where(and(...conditions)).limit(1);
    projectId = project?.id ?? null;
  }
  if (!projectId) return;

  await communityPointsService.awardForStepAdvance({
    ticketId: row.id,
    projectId,
    sourceType,
    creatorWidgetUserId,
    oldStatus,
    newStatus,
  });
}
```
Remove now-unused imports/vars from the old body (`workspaceTaskVotes` self-upvote lookup, etc.) if they are unreferenced elsewhere in the file.

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm -s vitest run src/api/services/WorkspaceTaskService.community-awarding.test.ts`
Expected: PASS.

- [ ] **Step 5: Full service test sweep + typecheck + commit**

Run:
```bash
pnpm -s vitest run src/api/services/CommunityPointsService.test.ts src/api/services/communityAwardingPolicy.test.ts src/api/services/WorkspaceTaskService.community-awarding.test.ts
pnpm -s tsc --noEmit
```
Expected: all PASS; tsc exits 0.
```bash
git add src/api/services/WorkspaceTaskService.ts src/api/services/WorkspaceTaskService.community-awarding.test.ts
git commit -m "feat(community): fire step-advance awarding from canonical task-status hook"
```

---

### Task 6: Extend `GET /api/widget/me/community` with `coinByTicket`

**Files:**
- Modify: `src/api/HttpServer.ts` (the `/api/widget/me/community` handler ~line 7502)
- Test: `src/api/HttpServer.community.test.ts` (add a case)

**Interfaces:**
- Consumes: `pointGrants` schema.
- Produces: response gains `coinByTicket: Record<string, { coin: number; reasons: string[] }>` (viewer's own `step_advance` grants grouped by `ticket_id`, reasons ordered by tier ordinal).

- [ ] **Step 1: Write the failing test**

Add to `src/api/HttpServer.community.test.ts` a case: seed two `step_advance` grants for the caller on ticket T (tiers `in_progress`, `reviewed`) and one on ticket U (`merged`); assert the `/api/widget/me/community` response has `coinByTicket[T] = { coin: 2, reasons: ['You ... In progress', 'You ... Reviewed'] }` and `coinByTicket[U].coin === 1`, and that another user's grants are excluded. Mirror the file's existing request/auth harness.

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm -s vitest run src/api/HttpServer.community.test.ts -t coinByTicket`
Expected: FAIL (`coinByTicket` undefined).

- [ ] **Step 3: Implement the grouping**

In the `/api/widget/me/community` handler, before the `return c.json({...})`, add:
```ts
const grantRows = await db
  .select({ ticketId: pointGrants.ticketId, amount: pointGrants.amount, reason: pointGrants.reason, metadata: pointGrants.metadata, createdAt: pointGrants.createdAt })
  .from(pointGrants)
  .where(and(
    eq(pointGrants.widgetUserId, widgetUserId),
    eq(pointGrants.source, 'step_advance'),
    isNotNull(pointGrants.ticketId),
  ))
  .orderBy(pointGrants.createdAt);

const TIER_ORD: Record<string, number> = { in_progress: 1, reviewed: 2, merged: 3, deployed: 4 };
const coinByTicket: Record<string, { coin: number; reasons: string[] }> = {};
for (const g of grantRows) {
  const tid = g.ticketId as string;
  const entry = coinByTicket[tid] ?? (coinByTicket[tid] = { coin: 0, reasons: [] });
  entry.coin += g.amount;
  const tier = (g.metadata as { tier?: string } | null)?.tier ?? '';
  entry.reasons.push(JSON.stringify({ o: TIER_ORD[tier] ?? 99, r: g.reason ?? '' }));
}
for (const tid of Object.keys(coinByTicket)) {
  coinByTicket[tid].reasons = coinByTicket[tid].reasons
    .map((s) => JSON.parse(s) as { o: number; r: string })
    .sort((a, b) => a.o - b.o)
    .map((x) => x.r);
}
```
Then add `coinByTicket` to the returned object. Ensure `isNotNull` is imported from `drizzle-orm` in this file (add to the existing drizzle import if missing).

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm -s vitest run src/api/HttpServer.community.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -s tsc --noEmit`
Expected: exits 0.
```bash
git add src/api/HttpServer.ts src/api/HttpServer.community.test.ts
git commit -m "feat(community): return per-ticket earned coin from /me/community"
```

---

### Task 7: Widget UI — header total, per-post chip, hover tooltip, live update

Vanilla JS in `public/widget.js`. No test framework for the widget; verify manually.

**Files:**
- Modify: `public/widget.js` (styles block; `renderTicketCard` ~line 3796; list-topbar render; panel-open data load; WS message handler)

**Interfaces:**
- Consumes: `GET /api/widget/me/community` → `{ balance, coinByTicket }` (Task 6); the existing `api(path, opts)` client; the existing community WS subscription/message handling.

- [ ] **Step 1: Add styles**

In the widget's injected CSS (the `.rw-` block), add:
```css
.rw-coin-total { display:inline-flex; align-items:center; gap:6px; margin-left:auto; padding:4px 10px;
  border-radius:999px; background:color-mix(in srgb, var(--rw-accent) 14%, transparent);
  color:var(--rw-accent); font-weight:700; font-size:13px; white-space:nowrap; }
.rw-coin-total .rw-coin-glyph { font-size:14px; line-height:1; }
.rw-coin-chip { display:inline-flex; align-items:center; gap:4px; margin-top:6px; padding:2px 8px;
  border-radius:999px; background:color-mix(in srgb, var(--rw-accent) 12%, transparent);
  color:var(--rw-accent); font-weight:600; font-size:12px; cursor:default; position:relative; }
.rw-coin-tip { position:absolute; bottom:calc(100% + 6px); left:0; z-index:40; max-width:260px;
  padding:8px 10px; border-radius:8px; background:var(--rw-fg); color:var(--rw-bg);
  font-size:12px; font-weight:500; line-height:1.4; box-shadow:0 6px 20px rgba(0,0,0,.25);
  white-space:normal; }
.rw-coin-tip ul { margin:4px 0 0; padding-left:16px; } .rw-coin-tip li { margin:2px 0; }
```

- [ ] **Step 2: Load community stats on panel open**

Add a module-level `var communityStats = { balance: 0, coinByTicket: {} };` and a loader:
```js
function loadCommunityStats() {
  return api("/api/widget/me/community").then(function (data) {
    if (!data) return;
    communityStats = { balance: data.balance || 0, coinByTicket: data.coinByTicket || {} };
    renderCoinTotal();
  }).catch(function () { /* best-effort; coin UI is non-critical */ });
}
```
Call `loadCommunityStats()` wherever the panel's initial list load happens (alongside `loadTopTickets()` on open).

- [ ] **Step 3: Render the header total**

In the `.rw-list-topbar` render, after appending `.rw-list-title`, append a coin badge and expose a re-render:
```js
function renderCoinTotal() {
  var host = shadow.querySelector(".rw-list-topbar"); if (!host) return;
  var existing = host.querySelector(".rw-coin-total"); if (existing) existing.remove();
  if (!communityStats || !communityStats.balance) return; // hide at zero
  var badge = h("span", { class: "rw-coin-total" },
    h("span", { class: "rw-coin-glyph" }, "🪙"),
    h("span", null, String(communityStats.balance)));
  host.appendChild(badge);
}
```
(Use the file's existing element helper — `h(...)` here stands for whatever the file uses to build nodes; match the surrounding code.)

- [ ] **Step 4: Per-post chip + tooltip in `renderTicketCard`**

Inside `renderTicketCard(ticket, opts)`, after the meta row is built, add:
```js
var earned = communityStats.coinByTicket && communityStats.coinByTicket[ticket.id];
if (earned && earned.coin) {
  var chip = h("span", { class: "rw-coin-chip" }, "+" + earned.coin + " 🪙");
  chip.setAttribute("tabindex", "0");
  chip.setAttribute("aria-label",
    "You earned " + earned.coin + " coin from this post. " + (earned.reasons || []).join(". "));
  var tip = null;
  function showTip() {
    if (tip) return;
    tip = h("span", { class: "rw-coin-tip" },
      h("div", null, "Why you earned coin:"),
      (function () {
        var ul = h("ul", null);
        (earned.reasons || []).forEach(function (r) { ul.appendChild(h("li", null, r)); });
        return ul;
      })());
    chip.appendChild(tip);
  }
  function hideTip() { if (tip) { tip.remove(); tip = null; } }
  chip.addEventListener("mouseenter", showTip);
  chip.addEventListener("mouseleave", hideTip);
  chip.addEventListener("focus", showTip);
  chip.addEventListener("blur", hideTip);
  // append chip to the card body (below the meta row)
  mainEl.appendChild(chip); // `mainEl` = the card's main column; match the actual variable name in the function
}
```

- [ ] **Step 5: Live update on balance change**

In the existing community WS message handler (`community_balance_changed` for this widget user), call `loadCommunityStats()` then re-render the visible list (or at minimum `renderCoinTotal()`), so header + chips reflect new coin without reopening. If no community WS subscription is currently wired in this widget build, add a subscribe to `community:widget_user:{id}` mirroring how the notifications feature subscribes; otherwise piggyback on the existing socket.

- [ ] **Step 6: Build + manual verification**

Run: `/app/data/home/runhq/scripts/apply-server-changes.sh` is for the runhq server — NOT this repo. For `be`, restart the local API per the be run instructions, then:
- Open the widget, submit a ticket as a widget user, upvote it from a second widget user.
- Advance the ticket `planned → in_progress → reviewed → merged → deployed` (via the workspace/console task UI or a direct `updateTask`).
- Confirm: header coin total increments (creator +4, voter +4 over the full run at 1/step); the ticket card shows a `+N 🪙` chip; hovering the chip lists the reasons; total updates live if the panel stays open.

- [ ] **Step 7: Commit**

```bash
git add public/widget.js
git commit -m "feat(widget): coin total in header, per-post earned-coin chip + why tooltip"
```

---

### Task 8: Final verification & push

- [ ] **Step 1: Full targeted test + typecheck**

Run:
```bash
pnpm -s vitest run src/api/services/communityAwardingPolicy.test.ts src/api/services/CommunityPointsService.test.ts src/api/services/WorkspaceTaskService.community-awarding.test.ts src/api/HttpServer.community.test.ts
pnpm -s tsc --noEmit
```
Expected: all PASS; tsc exits 0.

- [ ] **Step 2: Confirm branch, push**

Run:
```bash
git branch --show-current   # must be ticket-686e0758-community-coins
git push -u origin ticket-686e0758-community-coins
```

- [ ] **Step 3: runhq task branch**

In the runhq worktree (`/app/data/home/worktrees/ticket-686e0758`), the branch is `ticket-686e0758` but there is no runhq code change (be-only feature). Do NOT fabricate a change. Mark the job ready-for-review with a summary noting the real PR is the `be` branch.
```bash
runhq ready-for-review --summary "Community step-coins (be branch ticket-686e0758-community-coins): creators + voters earn 1 coin per lifecycle step; blatant header total, per-post chip, hover-why tooltip."
```

---

## Self-Review notes

- **Spec coverage:** ladder + fixed-1-coin (Task 3), creator+voter recipients & dedupe (Task 4), replace completion award (Task 4/5), one additive migration (Task 2), `coinByTicket` API (Task 6), header total + per-post chip + hover tooltip + live update (Task 7), master-merge for lifecycle (Task 1). All spec sections mapped.
- **Placeholders:** widget code uses `h(...)`, `mainEl`, `shadow` as stand-ins for the file's real element-builder/variable names — the implementer must match the surrounding code (called out inline). Not TODO placeholders; concrete logic is complete.
- **Type consistency:** `StepTier`, `crossedTiers`, `stepAdvanceIdempotencyKey`, `stepReason`, `StepAdvanceEvent`, `awardForStepAdvance`, `coinByTicket` names are used identically across tasks.
