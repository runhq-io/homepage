# Widget Live-Session Unread (assigner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a coder/teammate reply in a widget live session light the widget's launcher badge, notification bell, and a per-ticket dot for the staff member who assigned the coder, clearing when they open the session.

**Architecture:** Add a permission-scoped "assigned by me" ticket source on the server whose `lastActivityAt` includes non-`user` live-session chat messages, and fold it into the widget's existing unread machinery (`launcherBadgeCount`/`ticketHasUnseenActivity`) without touching the reporter's `listMyTickets`. The assigner is matched via the `agent_assigned` activity's `createdById = viewer.externalUserId`.

**Tech Stack:** TypeScript, Hono, Drizzle ORM (Postgres), Vitest; vanilla-JS widget (`public/widget.js`) tested via a vm + DOM-shim harness using `window._rwTestHooks`.

## Global Constraints

- Work in the worktree `/app/data/home/be-worktrees/ticket-acc8d215`, branch `ticket-acc8d215`. Verify with `git branch --show-current` before every commit.
- Run all commands from the worktree root. `node_modules` and `.env` are symlinked in; vitest DB tests read `DATABASE_URL` from `.env` (local scratch pg).
- Do NOT modify `listMyTickets`'s output semantics (the reporter's "My Submissions" badge must not start counting live-session messages — a public reporter cannot clear it).
- Live-session messages that count as unread are `widget_chat_messages` rows with `role != 'user'` (exclude the assigner's own messages) on the conversation linked to the ticket via `widget_chat_conversations.createdTaskId`.
- Badge semantics are per-session (count of tickets/sessions with unseen activity), matching today's "HQ N" — not a per-message tally.
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `src/api/services/WidgetService.ts` — add `widgetChatMessages` import; add `deriveLastActivity` helper; refactor `listMyTickets` to use it; add `listTicketsAssignedByMe`.
- `src/api/HttpServer.ts` — add `GET /api/widget/tickets/assigned` route.
- `public/widget.js` — `assignedTicketsCache` + `loadAssignedTickets` + load sites; `unreadCandidateTickets()` union; wire `launcherBadgeCount`/`renderNotifDropdown`; live-session `markTicketSeen` clear; per-ticket dot on the "Live session" button; `_rwTestHooks` exposure.
- `src/api/services/WidgetService.assignedUnread.test.ts` — new (service, real DB).
- `src/api/widget-js-live-session.test.ts` — extend (widget unread via hooks).

---

### Task 1: Server — extract `deriveLastActivity`, refactor `listMyTickets` (behavior-preserving)

**Files:**
- Modify: `src/api/services/WidgetService.ts` (import block ~14-29; `listMyTickets` ~2651-2709)
- Test: `src/api/services/WidgetService.badgeClears.repro.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: `deriveLastActivity(taskIds: string[], opts: { includeLiveSession: boolean }): Promise<Map<string, number>>` — maps taskId → max activity ms across comments + activity (+ non-`user` live-session chat messages when `includeLiveSession`). Excludes `task.updatedAt` (callers fold that in per-row).

- [ ] **Step 1: Add the `widgetChatMessages` import**

In the schema import block, add `widgetChatMessages` next to `widgetChatConversations`:

```ts
  widgetChatConversations,
  widgetChatMessages,
  widgetChatImages,
  type ChatImageRow,
} from '../../db/schema';
```

- [ ] **Step 2: Add the `deriveLastActivity` helper above `listMyTickets`**

Insert immediately before `export async function listMyTickets(`:

```ts
/**
 * Max "activity" timestamp (ms) per task across comments and activity rows, and
 * — when includeLiveSession is set — non-`user` live-session chat messages
 * (a coder's agent_message / a teammate's team_message on the conversation
 * linked via createdTaskId). The task's own updatedAt is folded in by callers.
 * Comments, activity, and chat messages do NOT bump workspaceTasks.updatedAt,
 * so this is what lets a reply light an unread badge. `user` chat rows are
 * excluded: the viewer's own message is not unread activity for them.
 */
async function deriveLastActivity(
  taskIds: string[],
  opts: { includeLiveSession: boolean },
): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  if (taskIds.length === 0) return latest;
  const bump = (taskId: string | null, raw: string | null) => {
    if (!taskId || !raw) return;
    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) return;
    if (!(latest.has(taskId) && latest.get(taskId)! >= ms)) latest.set(taskId, ms);
  };

  const queries: Promise<{ taskId: string | null; max: string | null }[]>[] = [
    db
      .select({ taskId: workspaceTaskComments.taskId, max: sql<string>`max(${workspaceTaskComments.createdAt})` })
      .from(workspaceTaskComments)
      .where(and(inArray(workspaceTaskComments.taskId, taskIds), isNull(workspaceTaskComments.deletedAt)))
      .groupBy(workspaceTaskComments.taskId),
    db
      .select({ taskId: workspaceTaskActivity.taskId, max: sql<string>`max(${workspaceTaskActivity.createdAt})` })
      .from(workspaceTaskActivity)
      .where(inArray(workspaceTaskActivity.taskId, taskIds))
      .groupBy(workspaceTaskActivity.taskId),
  ];
  if (opts.includeLiveSession) {
    queries.push(
      db
        .select({
          taskId: widgetChatConversations.createdTaskId,
          max: sql<string>`max(${widgetChatMessages.createdAt})`,
        })
        .from(widgetChatMessages)
        .innerJoin(widgetChatConversations, eq(widgetChatMessages.conversationId, widgetChatConversations.id))
        .where(and(
          inArray(widgetChatConversations.createdTaskId, taskIds),
          ne(widgetChatMessages.role, 'user'),
        ))
        .groupBy(widgetChatConversations.createdTaskId),
    );
  }

  const results = await Promise.all(queries);
  for (const rows of results) for (const r of rows) bump(r.taskId, r.max);
  return latest;
}
```

- [ ] **Step 3: Refactor `listMyTickets` to use the helper (no behavior change)**

Replace the block from `// Derive lastActivityAt = max(...)` through the `latest`/`bump`/`for` loops (down to just before `return rows.map(`) with:

```ts
  // Comments and activity do NOT bump workspaceTasks.updatedAt, so derive
  // lastActivityAt here. Live-session chat messages are intentionally NOT
  // included for the reporter: a public reporter cannot re-open a live session,
  // so its unread could never clear. The assigner gets that signal via
  // listTicketsAssignedByMe.
  const ids = rows.map((r) => r.id);
  const latest = await deriveLastActivity(ids, { includeLiveSession: false });
```

Leave the existing `return rows.map((t) => { ... dto.lastActivityAt = new Date(Math.max(updatedMs, activityMs)); ... })` exactly as-is.

- [ ] **Step 4: Run the existing badge repro test (behavior preserved)**

Run: `npx vitest run src/api/services/WidgetService.badgeClears.repro.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors in `WidgetService.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/api/services/WidgetService.ts
git commit -m "refactor(widget): extract deriveLastActivity helper from listMyTickets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Server — `listTicketsAssignedByMe`

**Files:**
- Modify: `src/api/services/WidgetService.ts` (add function after `listMyTickets`)
- Test: `src/api/services/WidgetService.assignedUnread.test.ts` (create)

**Interfaces:**
- Consumes: `deriveLastActivity` (Task 1); `getWidgetProjectContext`, `mapTaskToWidgetResponse`, `getWidgetUserAuditInfo` (existing); `WidgetTicketResponse` (existing return type of `listMyTickets`).
- Produces: `listTicketsAssignedByMe(projectId: string, widgetUserId: string): Promise<WidgetTicketResponse[]>` — tickets whose latest `agent_assigned` activity has `createdById = the widget user's externalUserId`, excluding terminal (cancelled / deployed[:env]) tickets, each carrying `lastActivityAt` that includes non-`user` live-session messages.

- [ ] **Step 1: Write the failing test**

Create `src/api/services/WidgetService.assignedUnread.test.ts`:

```ts
/**
 * listTicketsAssignedByMe: a live-session reply (coder agent_message / teammate
 * team_message) must light the assigner's widget unread. The assigner is the
 * author of the latest agent_assigned activity (createdById = their
 * externalUserId). Their OWN live message (role='user') is not unread for them.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users, servers, workspaceTasks, workspaceTaskActivity,
  widgetProjects, widgetUsers, widgetChatConversations,
} from '../../db/schema';
import { listTicketsAssignedByMe } from './WidgetService';
import * as WidgetChatService from './WidgetChatService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_asn_${RUN_HEX}`;
const USER_ID = `00000000-000a-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-${RUN_HEX}`;
let PROJECT_ID: string;
let ASSIGNER_WUID: string;          // the assigner's widget user id
const ASSIGNER_EXT = `runhq:assigner-${RUN_HEX}`;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `ASN ${RUN_HEX}`, slug: `asn-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`, apiSecretHash: `secret-${RUN_HEX}`,
    channelId: CHANNEL_ID, enabled: true, isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: ASSIGNER_EXT, name: 'Assigner',
  }).returning({ id: widgetUsers.id });
  ASSIGNER_WUID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function makeAssignedTask(title: string, assignerExt: string, status = 'in_progress') {
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, workspaceChannelId: CHANNEL_ID, title,
    visibility: 'public', status,
    sourceType: 'widget', createdByType: 'external', createdById: ASSIGNER_WUID,
  }).returning({ id: workspaceTasks.id });
  await db.insert(workspaceTaskActivity).values({
    serverId: SERVER_ID, taskId: task!.id, type: 'agent_assigned',
    metadata: { agentName: 'Coder' },
    createdByType: 'external', createdById: assignerExt, createdByName: 'Assigner',
  });
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: ASSIGNER_WUID,
    status: 'active', createdTaskId: task!.id,
  }).returning({ id: widgetChatConversations.id });
  return { taskId: task!.id, convId: conv!.id };
}

describe('listTicketsAssignedByMe', () => {
  it('returns tickets I assigned and excludes ones assigned by someone else', async () => {
    const mine = await makeAssignedTask('Mine', ASSIGNER_EXT);
    const other = await makeAssignedTask('Other', `runhq:someone-else-${RUN_HEX}`);
    try {
      const rows = await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(mine.taskId);
      expect(ids).not.toContain(other.taskId);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, mine.taskId));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, other.taskId));
    }
  });

  it('lastActivityAt advances on a coder reply but not on the assigner\'s own message', async () => {
    const { taskId, convId } = await makeAssignedTask('Activity', ASSIGNER_EXT);
    try {
      const base = new Date(
        (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).find((r) => r.id === taskId)!.lastActivityAt!,
      ).getTime();

      // assigner's own live message → role='user' → must NOT bump
      await new Promise((r) => setTimeout(r, 10));
      await WidgetChatService.sendLiveCoderMessage(convId, PROJECT_ID, 'Any update?');
      const afterOwn = new Date(
        (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).find((r) => r.id === taskId)!.lastActivityAt!,
      ).getTime();
      expect(afterOwn).toBe(base);

      // coder reply → role='agent' → must bump
      await new Promise((r) => setTimeout(r, 10));
      await WidgetChatService.ingestTurnEvents(SERVER_ID, {
        conversationId: convId, turnId: `turn-${RUN_HEX}`,
        events: [{ kind: 'agent_message', seq: 0, text: 'Pushed a fix.' }],
      });
      const afterReply = new Date(
        (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).find((r) => r.id === taskId)!.lastActivityAt!,
      ).getTime();
      expect(afterReply).toBeGreaterThan(base);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, taskId));
    }
  });

  it('excludes terminal (deployed) tickets', async () => {
    const { taskId } = await makeAssignedTask('Done', ASSIGNER_EXT, 'deployed');
    try {
      const ids = (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).map((r) => r.id);
      expect(ids).not.toContain(taskId);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, taskId));
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/api/services/WidgetService.assignedUnread.test.ts`
Expected: FAIL — `listTicketsAssignedByMe is not a function` (import error / not exported).

- [ ] **Step 3: Implement `listTicketsAssignedByMe`**

Add immediately after the end of `listMyTickets` in `src/api/services/WidgetService.ts`:

```ts
/**
 * Tickets the given widget user ASSIGNED a coder agent to (the latest
 * agent_assigned activity's createdById equals their externalUserId), excluding
 * terminal tickets. lastActivityAt includes non-`user` live-session chat
 * messages so a coder/teammate reply lights the assigner's widget unread. This
 * is the assigner-scoped counterpart to listMyTickets (which is reporter-scoped
 * and deliberately omits live-session messages).
 */
export async function listTicketsAssignedByMe(
  projectId: string,
  widgetUserId: string,
): Promise<WidgetTicketResponse[]> {
  const project = await getWidgetProjectContext(projectId);
  if (!project) return [];
  const audit = await getWidgetUserAuditInfo(widgetUserId);
  if (!audit) return [];
  const externalUserId = audit.externalUserId;

  // Latest agent_assigned activity per task on this server, with its author.
  const assignRows = await db
    .select({
      taskId: workspaceTaskActivity.taskId,
      createdById: workspaceTaskActivity.createdById,
      createdAt: workspaceTaskActivity.createdAt,
    })
    .from(workspaceTaskActivity)
    .where(and(
      eq(workspaceTaskActivity.serverId, project.serverId),
      eq(workspaceTaskActivity.type, 'agent_assigned'),
    ))
    .orderBy(desc(workspaceTaskActivity.createdAt));

  // Keep only the most-recent assignment per task (assignRows is newest-first),
  // then keep tasks whose latest assigner is this viewer.
  const latestAssigner = new Map<string, string | null>();
  for (const r of assignRows) {
    if (!latestAssigner.has(r.taskId)) latestAssigner.set(r.taskId, r.createdById);
  }
  const mineTaskIds = [...latestAssigner.entries()]
    .filter(([, by]) => by === externalUserId)
    .map(([taskId]) => taskId);
  if (mineTaskIds.length === 0) return [];

  // Load the (non-terminal, non-deleted) tasks themselves.
  const rows = await db
    .select()
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.serverId, project.serverId),
      inArray(workspaceTasks.id, mineTaskIds),
      isNull(workspaceTasks.deletedAt),
      ne(workspaceTasks.status, 'cancelled'),
      ne(workspaceTasks.status, 'deployed'),
      sql`${workspaceTasks.status} not like 'deployed:%'`,
    ))
    .orderBy(desc(workspaceTasks.createdAt))
    .limit(50);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const latest = await deriveLastActivity(ids, { includeLiveSession: true });
  return rows.map((t) => {
    const dto = mapTaskToWidgetResponse(t);
    const updatedMs = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
    const activityMs = latest.get(t.id) ?? 0;
    dto.lastActivityAt = new Date(Math.max(updatedMs, activityMs));
    return dto;
  });
}
```

Note: `workspaceTaskActivity` is already imported; confirm `ne` and `inArray` are in the drizzle import (they are).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/api/services/WidgetService.assignedUnread.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/services/WidgetService.ts src/api/services/WidgetService.assignedUnread.test.ts
git commit -m "feat(widget): listTicketsAssignedByMe with live-session activity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Server — `GET /api/widget/tickets/assigned` route

**Files:**
- Modify: `src/api/HttpServer.ts` (near the other `/api/widget/tickets/*` routes; `/mine` is at the `loadMyTickets` endpoint)

**Interfaces:**
- Consumes: `WidgetService.authenticateWidget`, `WidgetService.listTicketsAssignedByMe` (Task 2).
- Produces: `GET /api/widget/tickets/assigned` → `{ tickets: WidgetTicketResponse[] }`; `[]` when unidentified-but-authed-with-no-assignments; 401 when not an identified user.

- [ ] **Step 1: Find the `/api/widget/tickets/mine` route as the pattern to mirror**

Run: `grep -n "api/widget/tickets/mine" src/api/HttpServer.ts`
Read ~15 lines around it to copy its auth + response shape exactly.

- [ ] **Step 2: Add the `assigned` route immediately after the `mine` route**

Use the same auth guard the `mine` route uses. Pattern (adapt variable names to match the `mine` handler you just read):

```ts
  // Tickets the viewer assigned a coder to, with live-session activity folded
  // into lastActivityAt — drives the widget's live-session unread indicators.
  app.get('/api/widget/tickets/assigned', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (!auth.widgetUserId) return c.json({ error: 'Identified user required' }, 401);
    const tickets = await WidgetService.listTicketsAssignedByMe(auth.projectId, auth.widgetUserId);
    return c.json({ tickets });
  });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/api/HttpServer.ts
git commit -m "feat(widget): GET /api/widget/tickets/assigned route

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Widget — assigned cache + union into badge/bell

**Files:**
- Modify: `public/widget.js` (cache decl ~43; api helpers ~261; `launcherBadgeCount` ~1437; `renderNotifDropdown` ~1721; `refreshAll` ~4789; init ~7896; `fetchAndApplyMe` ~587; project-switch reset ~4474)

**Interfaces:**
- Produces: `assignedTicketsCache` (array|null); `loadAssignedTickets()` (api call); `unreadCandidateTickets()` → deduped union of `myTicketsCache` + `assignedTicketsCache`; `viewerCanLiveCoder()` permission gate.

- [ ] **Step 1: Declare the cache**

Below `var myTicketsCache = null;` (line ~43):

```js
  var assignedTicketsCache = null; // /api/widget/tickets/assigned — live sessions the viewer assigned
```

- [ ] **Step 2: Add the api helper**

Below `function loadMyTickets() { return api("/api/widget/tickets/mine"); }` (~261):

```js
  function loadAssignedTickets()  { return api("/api/widget/tickets/assigned"); }
```

- [ ] **Step 3: Add permission gate + union helpers**

Immediately above `function launcherBadgeCount() {` (~1437):

```js
  // Only viewers who can OPEN a live session (live_coder / assign_agent) get the
  // assigned-session unread signal — they are the only ones who can clear it.
  function viewerCanLiveCoder() {
    var p = currentUser.permissions || [];
    return p.indexOf("live_coder") !== -1 || p.indexOf("assign_agent") !== -1;
  }

  // Deduped union of the viewer's reported tickets and the live sessions they
  // assigned. Both carry lastActivityAt, so the existing unread predicate works.
  function unreadCandidateTickets() {
    var byId = {};
    var out = [];
    var push = function (tk) {
      if (!tk || !tk.id || byId[tk.id]) return;
      byId[tk.id] = true; out.push(tk);
    };
    (myTicketsCache || []).forEach(push);
    (assignedTicketsCache || []).forEach(push);
    return out;
  }
```

- [ ] **Step 4: Point `launcherBadgeCount` at the union**

Replace the body of `launcherBadgeCount`:

```js
  function launcherBadgeCount() {
    if (!config.isIdentified) return 0;
    var items = unreadCandidateTickets();
    var n = 0;
    for (var j = 0; j < items.length; j++) {
      if (ticketHasUnseenActivity(items[j])) n++;
    }
    return n;
  }
```

- [ ] **Step 5: Point the bell dropdown at the union**

In `renderNotifDropdown`, change:

```js
    var items = (myTicketsCache || []).filter(ticketHasUnseenActivity);
```

to:

```js
    var items = unreadCandidateTickets().filter(ticketHasUnseenActivity);
```

- [ ] **Step 6: Load the assigned cache in `refreshAll`**

In `refreshAll`, after the `mineP` declaration (~4823), add:

```js
    var assignedP = (config.isIdentified && viewerCanLiveCoder())
      ? loadAssignedTickets().then(function (d) { assignedTicketsCache = d.tickets || []; }).catch(function () { assignedTicketsCache = []; })
      : Promise.resolve().then(function () { assignedTicketsCache = []; });
```

and add `assignedP` to the `Promise.all([...])` list.

- [ ] **Step 7: Load the assigned cache after `/me` resolves**

In `fetchAndApplyMe`, inside the `loadMe().then(...)` success body, after `currentUser.isTriager = ...` and before the re-render, add:

```js
      if (config.isIdentified && viewerCanLiveCoder()) {
        loadAssignedTickets()
          .then(function (d) { assignedTicketsCache = d.tickets || []; refreshTabLabel(); })
          .catch(function () {});
      }
```

- [ ] **Step 8: Reset the cache on project switch / logout**

Where `myTicketsCache = null;` is reset alongside `topTicketsCache`/`updatesCache` (~4474), add `assignedTicketsCache = null;`. In the anon branch of init (~7900) where `myTicketsCache = []`, add `assignedTicketsCache = [];`.

- [ ] **Step 9: Sanity-build the widget file (syntax check)**

Run: `node --check public/widget.js`
Expected: no output (valid syntax).

- [ ] **Step 10: Commit**

```bash
git add public/widget.js
git commit -m "feat(widget): fold assigned live sessions into launcher badge + bell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Widget — clear-on-read, per-ticket dot, test hooks + test

**Files:**
- Modify: `public/widget.js` (`renderChatMessageList` ~5766; "Live session" button ~6826; `_rwTestHooks` ~7943)
- Test: `src/api/widget-js-live-session.test.ts` (extend)

**Interfaces:**
- Consumes: `markTicketSeen`, `getTicketSeen`, `ticketHasUnseenActivity`, `launcherBadgeCount`, `unreadCandidateTickets` (Task 4), `chatConversation`, `liveSessionTicket`.
- Produces: live-session `markTicketSeen` on render; `.rw-unseen-dot` on the Live session button; `_rwTestHooks.launcherBadgeCount`, `_rwTestHooks.markTicketSeen`, `_rwTestHooks._setCaches`.

- [ ] **Step 1: Mark the live session seen when its messages render**

In `renderChatMessageList`, inside `if (chatIsLiveSession) {`, after the empty-state block and before the message loop, add:

```js
      // Reading the live session marks its ticket seen up to the freshest
      // message, so the launcher/bell/dot clear and only re-light on the next
      // reply. createdTaskId links the conversation to the ticket.
      var liveTaskId = chatConversation && chatConversation.createdTaskId;
      if (liveTaskId && chatMessages.length > 0) {
        var seenMs = 0;
        for (var si = 0; si < chatMessages.length; si++) {
          seenMs = Math.max(seenMs, new Date(chatMessages[si].createdAt || 0).getTime() || 0);
        }
        if (seenMs > 0) { markTicketSeen(liveTaskId, seenMs); refreshNotifBell(); }
      }
```

- [ ] **Step 2: Add the unread dot to the "Live session" button**

In the live-session button block (~6826), after the `liveBtn` is created, add a dot when the ticket has unseen activity:

```js
      if (ticketHasUnseenActivity(ticket)) {
        liveBtn.insertBefore(h("span", { className: "rw-unseen-dot" }), liveBtn.firstChild);
      }
```

(`.rw-unseen-dot` already exists in the stylesheet — used by the bell list.)

- [ ] **Step 3: Expose test hooks**

In the `_rwTestHooks` block (~7943), add:

```js
    window._rwTestHooks.launcherBadgeCount = launcherBadgeCount;
    window._rwTestHooks.markTicketSeen = markTicketSeen;
    window._rwTestHooks._setCaches = function (mine, assigned) {
      myTicketsCache = mine || [];
      assignedTicketsCache = assigned || [];
    };
```

- [ ] **Step 4: Write the failing widget test**

Read the top of `src/api/widget-js-live-session.test.ts` to reuse its vm + DOM-shim + localStorage-shim bootstrap, then add this `describe` block (adapt the harness setup names to those already in the file; the file already sets `config.isIdentified` and `currentUser.permissions` via its bootstrap — set them in the test as that file does):

```ts
describe('live-session unread badge (assigner)', () => {
  it('counts an assigned session with unseen activity and clears on read', () => {
    const hooks = bootWidget(); // existing helper in this file that returns window._rwTestHooks
    // identified staff viewer
    setIdentified(true);                 // existing helper or set config.isIdentified directly
    setPermissions(['live_coder']);      // existing helper or set currentUser.permissions
    const now = Date.now();
    const ticket = {
      id: 'task-1', title: 'Assigned', createdAt: new Date(now - 10000).toISOString(),
      lastActivityAt: new Date(now).toISOString(),
    };
    hooks._setCaches([], [ticket]);
    expect(hooks.launcherBadgeCount()).toBe(1);

    // reading the session up to the latest message clears it
    hooks.markTicketSeen('task-1', now);
    expect(hooks.launcherBadgeCount()).toBe(0);
  });
});
```

- [ ] **Step 5: Run the widget test to verify it fails, then passes after Steps 1-3 are in place**

Run: `npx vitest run src/api/widget-js-live-session.test.ts`
Expected: the new test PASSES (Steps 1-3 already implemented); existing tests stay green.

- [ ] **Step 6: Syntax check + commit**

```bash
node --check public/widget.js
git add public/widget.js src/api/widget-js-live-session.test.ts
git commit -m "feat(widget): clear live-session unread on read + dot on Live session button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the full widget/service test slice**

Run:
```bash
npx vitest run src/api/services/WidgetService.assignedUnread.test.ts \
  src/api/services/WidgetService.badgeClears.repro.test.ts \
  src/api/widget-js-live-session.test.ts \
  src/api/services/WidgetChatService.ingest.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck the whole server**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Apply to local dev containers (so the user can eyeball the widget)**

Build the widget into `be/public` is already source-served; for the BE API rebuild run the be apply path if present, otherwise restart the local BE. (BE runs from `src` via tsx in dev — no build step for routes.) Confirm `/api/widget/tickets/assigned` responds with the local server.

- [ ] **Step 4: Mark ready** — handled by the outer task instructions (commit, push `ticket-acc8d215`, `runhq ready-for-review`).

---

## Self-Review

- **Spec coverage:** server `listTicketsAssignedByMe` + route (Tasks 2-3); live-session messages in `lastActivityAt` via `deriveLastActivity` (Task 1-2); assigner match via `agent_assigned.createdById` (Task 2); widget union badge + bell (Task 4); clear-on-read + per-ticket dot (Task 5); `listMyTickets` untouched in output (Task 1 preserves the return); terminal exclusion (Task 2). All covered.
- **Placeholders:** none — every code step has full code. The widget test (Task 5) notes adapting to the existing harness helpers in `widget-js-live-session.test.ts`; that is a real, named file whose bootstrap is reused.
- **Type consistency:** `deriveLastActivity(taskIds, {includeLiveSession})` signature is identical across Tasks 1 and 2; `listTicketsAssignedByMe(projectId, widgetUserId)` identical across Tasks 2-3; `unreadCandidateTickets`/`viewerCanLiveCoder`/`loadAssignedTickets`/`assignedTicketsCache` names consistent across Tasks 4-5.
