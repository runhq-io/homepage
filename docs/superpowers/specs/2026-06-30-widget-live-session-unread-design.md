# Widget live-session unread for the assigner — design

**Date:** 2026-06-30
**Ticket:** acc8d215 — "new messages in the live session of widget (../be) isn't taken into account for unread notifications etc."
**Repo:** `../be` (server-side data + API + `public/widget.js`). Read-only dependency on runhq-cloud for how assignment is recorded.

## Problem

A widget "live session" is a `widget_chat_conversations` row with `createdTaskId` set, linked to a
`workspace_tasks` ticket. A coder agent posts `agent_message` rows and teammates post `team_message`
rows into it (via `WidgetChatService.ingestTurnEvents`). These are the messages a staff member follows
during a live session.

The widget's launcher badge ("HQ 2" pill), notification bell, and per-ticket unread dot are all driven
by `launcherBadgeCount()` / `ticketHasUnseenActivity()` over `myTicketsCache`, which comes from
`GET /api/widget/tickets/mine` → `WidgetService.listMyTickets`. That function derives `lastActivityAt`
from `max(task.updatedAt, latest comment, latest activity)` — it never looks at `widget_chat_messages`.

**Result:** when a coder agent or a teammate replies in a live session, nothing the widget's unread
machinery reads changes, so the staff member who assigned the coder gets no unread indication. Live
sessions have no unread indicator in the widget at all.

## Goal

The widget's unread surfaces (launcher number, notification bell list, per-ticket dot) reflect new
live-session replies for **the staff member who assigned the coder agent**. Unread appears when a coder
agent (`agent_message`) or a teammate (`team_message`) replies; it clears when the assigner opens the
live session.

Non-goals: the runhq-cloud "Conversations" inbox unread (separate surface, already exists); a numeric
per-message counter (we keep today's per-session count semantics); lighting the reporter's badge for
live sessions (a public reporter cannot re-open a live session, so its badge could never clear).

## Why "assigned-by-me" is the right scope

Only a viewer who can **open** a live session can ever **clear** its unread. The "Live session" button
in `public/widget.js` is gated on the `live_coder` permission; a public visitor has no path to re-open a
`createdTaskId` conversation (`findActiveConversation` excludes them). Scoping the new signal to the
assigner — who holds `assign_agent`/`live_coder` and therefore can open the session — guarantees the
badge is clearable. `listMyTickets` (the reporter's "My Submissions") is left untouched.

## How the assigner is identified

Assignment is recorded as a `workspace_task_activity` row, `type = 'agent_assigned'`, with
`createdByType = 'external'` and `createdById = actor.externalUserId` (runhq-cloud
`server/src/services/widgetTicketAssign.ts`). The widget viewer's `externalUserId` is known at auth time
(`WidgetService.authenticateWidget`; recognized runhq members carry `externalUserId = "runhq:<userId>"`).

So **"tickets I assigned" = tasks whose latest `agent_assigned` activity has
`createdById = viewer.externalUserId`.** Assignments made from the runhq-cloud workspace (a `member`
actor, not an `external` widget identity) will not match a widget viewer and are intentionally out of
scope for the widget badge — they belong to the workspace inbox.

## Architecture

Two additive layers; no change to existing reporter unread.

### Server (be)

1. **`WidgetService.listTicketsAssignedByMe(projectId, viewerExternalId): WidgetTicketResponse[]`**
   - Find tasks for the project's server whose **latest** `agent_assigned` activity has
     `createdById = viewerExternalId`. ("Latest" so a re-assignment to a different person hands the
     session off; only the current assigner sees it.)
   - Drop terminal tickets (cancelled / deployed) — a closed-out ticket should not nag. (Match the
     existing widget notion of "open"; reuse the status predicate already used elsewhere.)
   - Compute `lastActivityAt = max(task.updatedAt, latest comment, latest activity, latest NON-user
     live-session chat message)` per ticket. The last term is the new signal:
     `widget_chat_messages.createdAt` for `role != 'user'`, joined to the ticket via
     `widget_chat_conversations.createdTaskId`.
   - Reuse a shared `deriveLastActivity(taskIds, { includeLiveSession })` helper so the comment/activity
     aggregation is not duplicated between this and `listMyTickets`. `listMyTickets` keeps
     `includeLiveSession = false`; the assigned list uses `true`.

2. **`GET /api/widget/tickets/assigned`** — identified widget user required; returns
   `{ tickets: listTicketsAssignedByMe(projectId, auth.externalUserId) }`. Returns `[]` when the viewer
   has assigned nothing (so it is safe to call for any identified user).

### Client (`public/widget.js`)

3. **`assignedTicketsCache`** (sibling of `myTicketsCache`), loaded from `/api/widget/tickets/assigned`
   in `refreshAll` and after `/api/widget/me` resolves, gated on the viewer holding `live_coder` or
   `assign_agent` (avoids an extra request for pure visitors). Cleared alongside `myTicketsCache`.

4. **Union into existing unread machinery** (no new badge math):
   - `launcherBadgeCount()` counts `ticketHasUnseenActivity` across the **dedup union** of
     `myTicketsCache` + `assignedTicketsCache` (by ticket id).
   - `refreshNotifBell()` builds its list from the same union.
   - `ticketHasUnseenActivity` is unchanged; assigned tickets carry `lastActivityAt`, so they qualify.

5. **Clear on read.** When the assigner opens the live session, `renderChatMessageList` (in the
   `chatIsLiveSession` branch) calls `markTicketSeen(chatConversation.createdTaskId, maxMsgMs)` where
   `maxMsgMs` is the newest rendered `widget_chat_messages.createdAt`. Symmetric with `renderDetailInto`,
   which already marks tickets seen up to the freshest rendered server timestamp. Detail-view alone will
   not clear live-session unread (detail does not render chat messages) — by design, the assigner must
   open the session to read coder replies.

6. **Per-ticket dot.** Bell-list rows already render a dot via `ticketHasUnseenActivity`. Additionally,
   show a dot on the "Live session" button in ticket detail when that ticket has unseen live-session
   activity.

## Data flow

```
coder/teammate reply
  → WidgetChatService.ingestTurnEvents inserts widget_chat_messages(role agent|team)  [unchanged]
assigner's widget polls refreshAll
  → GET /api/widget/tickets/assigned
     → listTicketsAssignedByMe: latest agent_assigned.createdById == viewer.externalUserId,
       lastActivityAt includes the new non-user chat message
  → assignedTicketsCache updated
  → launcherBadgeCount()/refreshNotifBell() count it as unseen (lastActivityAt > seen[id])
assigner opens Live session
  → renderChatMessageList marks markTicketSeen(createdTaskId, maxMsgMs)
  → badge/bell/dot clear; re-light only on the next reply
```

## Semantics

Count is **sessions with unread replies**, matching today's "HQ N" = N items — a session contributes 1
once it has an unseen reply, regardless of how many messages arrived. (A per-message tally was considered
and rejected as inconsistent with the current badge.)

## Error handling / edge cases

- `/api/widget/tickets/assigned` for a non-staff or no-assignment viewer → `[]` (no error).
- Re-assignment to a different person: only the current (latest) assigner matches, so the previous
  assigner stops seeing it. Acceptable and arguably correct.
- Permissions arrive async (`fetchAndApplyMe`): load `assignedTicketsCache` both after `/me` resolves
  and in `refreshAll` when the permission is already known; a missing/failed load resolves to `[]`.
- A ticket that is both reported-by and assigned-by the same viewer is deduped by id in the union (no
  double count).

## Testing

- **be (real DB, real ingest path):**
  - `listTicketsAssignedByMe` returns a task whose latest `agent_assigned.createdById` matches the
    viewer and excludes one assigned by someone else.
  - Its `lastActivityAt` advances on an ingested `agent_message`/`team_message` and does **not** advance
    on the assigner's own `role='user'` live message.
  - Terminal tickets are excluded.
- **widget (`_rwTestHooks` + vm/DOM shim):**
  - The union badge counts an assigned session with unseen activity.
  - Opening the live session clears it (`markTicketSeen` called with the newest message time).

## Files touched

- `src/api/services/WidgetService.ts` — `deriveLastActivity` helper, `listTicketsAssignedByMe`,
  `widgetChatMessages` import (added).
- `src/api/HttpServer.ts` — `GET /api/widget/tickets/assigned` route.
- `public/widget.js` — `assignedTicketsCache`, loader, badge/bell union, live-session `markTicketSeen`,
  per-ticket dot on the "Live session" button, `_rwTestHooks` exposure.
- Tests: `src/api/services/WidgetService.assignedUnread.test.ts`,
  widget coverage in `src/api/widget-js-live-session.test.ts`.
