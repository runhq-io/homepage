# Widget: Updates Tab + Posting Comments

## Ships

This work ships in two releases. Ship-1 is the core product win (Updates tab + commenting with app-provided auth); Ship-2 is a significant auth expansion (RunHQ-native login as an alternative commenter identity, plus a standalone widget-visibility setting). Each is independently deployable.

- **Ship-1 (this spec, main body):** Updates tab, comment composer (post / edit / delete with image attachments), shared storage with the RunHQ app, explicit `app-user (id:…)` labeling for externally-authed commenters.
- **Ship-2 (appendix at end of this document):** "Log in with RunHQ" OAuth flow for commenting/voting by RunHQ members, with permission-gated write access via the existing `comment_todo` / `upvote_todo` flags. Anonymous widget visibility is already covered by the existing `isPublic` setting — no new toggle needed.

The main body of this document is the Ship-1 spec. Ship-2 is fully designed in the appendix so future planning has continuity, but it is out of scope for the immediate implementation run.

## Problem

The RunHQ feedback widget (`/app/data/home/be/public/widget.js`) currently has two tabs — "Recent Tickets" (open tickets only) and "My Tickets" (the current user's submissions) — and while it *renders* comments inside the ticket-detail view's timeline, it provides no way for a visitor to *post* one.

Two gaps result:

1. **No visibility into resolved work.** `renderTicketList()` explicitly filters out `done` and `cancelled` tickets, so a visitor has no way to see what has actually shipped. There is no public changelog surface.
2. **Read-only comments.** Comments already exist in the data model (`workspace_task_comments`) and are returned by `GET /api/widget/tickets/:id`, but there is no `POST /api/widget/tickets/:id/comments` endpoint and no comment composer in the widget's detail view. Visitors can read the conversation but cannot join it.

## Goal

Extend the widget from two tabs to three — `[Updates] [Recent Tickets] [My Tickets]` — where **Updates** is a project-wide feed of done tickets sorted by `completedAt` descending, and add a **comment composer** (with image attachments and edit/delete) inside the existing ticket-detail view. All comment storage is unified with the RunHQ app: widget comments and RunHQ-app comments write to the same `workspace_task_comments` table, so conversations are continuous across surfaces.

## User-Facing Behavior

### Updates tab

- **Position:** First tab. Order becomes `[Updates] [Recent Tickets] [My Tickets]`.
- **Visibility:** Shown to all visitors — identified or not. (Today, tabs are hidden until login; that changes. `My Tickets` remains gated behind identification.)
- **Contents:** Public done tickets in the project, sorted by `completedAt` descending, limit 20 in the first release.
- **Card layout** (per ticket): title, short description (truncated ~140 chars), a green "Done" status badge, and a relative "Shipped 3d ago" timestamp. Clicking opens the existing ticket detail view.
- **Empty state:** "Nothing shipped yet."
- **Loading:** Standard `renderLoading()` skeleton while fetching.

### Commenting on tickets

- **Composer location:** Below the existing timeline inside the ticket detail view.
- **Authorization:** Any identified (logged-in) widget user can post a comment on any ticket they can view. Unidentified users see a "Log in to comment" prompt in place of the composer.
- **Attachments:** Paste or upload images alongside a comment, up to 5 per comment, reusing the existing attachment infrastructure and upload endpoint pattern from ticket creation.
- **Edit:** The comment author can edit their own comment. After an edit, the comment renders with a subtle `(edited)` marker adjacent to the timestamp; hovering the marker reveals the absolute edit time (Discord-style — `title` attribute tooltip).
- **Delete:** The comment author can delete their own comment (soft delete, matching the existing `workspaceTaskComments.deletedAt` pattern).
- **No threading** in this release. Flat list ordered by `createdAt` ascending (as today).

## Architectural Decisions

### Widget surface is vanilla JS — intentional

`public/widget.js` is authored as a single self-contained vanilla JS file with no dependencies so it can be embedded on any origin without a toolchain. Every change in this plan adds to that file directly. Rewriting to a framework is out of scope.

### New widget-namespaced routes, not piggybacking on internal routes

Widget calls authenticate via `WidgetService.authenticateWidget()` and produce a `widgetUserId` with `createdByType: 'external'`. The internal RunHQ task routes authenticate differently. Rather than threading two auth models through one endpoint, we add a small set of `/api/widget/*` routes that delegate to the shared `WorkspaceTaskService` for the actual logic. This matches the existing pattern (`/api/widget/tickets`, `/api/widget/tickets/mine`, `/api/widget/tickets/stats`, …).

### Dedicated Updates endpoint, not a filter on `listTickets`

`GET /api/widget/tickets` today returns open tickets ordered by `createdAt` with limit 50; all of that is baked into `listTickets()`. Updates needs a different order (`completedAt desc`), a different status filter (`done`), and a different default limit (20). A dedicated `GET /api/widget/tickets/updates` route + a dedicated `listDoneTickets()` service function keeps both code paths straightforward and avoids overloading one endpoint with branches.

### Comment storage is shared between widget and RunHQ app

No new table. No sync layer. Both surfaces write to `workspace_task_comments` via `WorkspaceTaskService.addComment()`. The `createdByType` column (`'external'` for widget, `'member'` for RunHQ) is the only indicator distinguishing origin. Consequently: a comment posted in the widget is immediately visible in the RunHQ app task detail (and vice-versa) with zero extra work.

### Author display — explicit `app-user (id:…)` labeling

Every surface that renders an author (ticket cards, ticket detail meta row, comments in the timeline) formats externally-authenticated authors as:

- `"{createdByName} (app-user id:{externalUserId})"` when the JWT provided a `name` claim, e.g. `"Alice (app-user id:u_abc123)"`
- `"app-user (id:{externalUserId})"` when no name was provided (replaces today's `"Anonymous"` fallback)

This makes the origin of the comment unambiguous — visitors browsing the widget can see at a glance which author is an external app user (vs. a RunHQ member, once Ship-2 lands). The format is applied in the widget renderer (a new `formatAuthorName(authorName, externalUserId, createdByType)` helper), so no backend change is needed for the label itself — but the backend must expose `externalUserId` on comment/ticket payloads.

## Data Model

**No schema migrations required.** Every column we need already exists:

- `workspace_task_comments.createdAt` / `.updatedAt` — already populated; widget can detect "edited" via `updatedAt !== createdAt`.
- `workspace_task_comments.deletedAt` — already exists; used by existing `deleteComment()`.
- `workspace_task_attachments.ownerType='comment'` — already supported (the attachment owner type union is `'task' | 'comment' | 'activity'`).
- `workspace_tasks.completedAt` — already populated when a task transitions to `done` (already used in `getTicketStats` average-resolution computation).

## Authorization

| Action | Widget auth required | Additional check |
|---|---|---|
| `GET /api/widget/tickets/updates` | None (public feed, like `/api/widget/tickets`) | — |
| `POST /api/widget/tickets/:id/comments` | Signed widget token (identified user) | Ticket must be visible to the widget user (reuses `buildWidgetVisibleFilter` + visibility=public) |
| `POST /api/widget/tickets/:id/comments/:cid/attachments` | Signed widget token | Must be the comment author (`createdById === widgetUserId`) |
| `PATCH /api/widget/tickets/:id/comments/:cid` | Signed widget token | Must be the comment author |
| `DELETE /api/widget/tickets/:id/comments/:cid` | Signed widget token | Must be the comment author |

The authoring check compares `workspace_task_comments.createdById` against the widget-authenticated `widgetUserId`. We do **not** let widget users edit/delete comments authored by RunHQ members (`createdByType === 'member'`), even if IDs happen to match — the check is `createdByType === 'external' AND createdById === widgetUserId`.

## Backend Changes (`/app/data/home/be`)

### 1. `WorkspaceTaskService.updateComment()` — new function

File: `src/api/services/WorkspaceTaskService.ts`

Signature:

```typescript
export async function updateComment(
  serverId: string,
  taskId: string,
  commentId: string,
  input: { content: string },
): Promise<CanonicalTaskComment | null>
```

Behavior: updates `content` and bumps `updatedAt = now()`. Returns the updated comment (with its attachments), or `null` if not found / already soft-deleted. Does **not** enforce author check itself — callers enforce authorization. Follows the same shape as the existing `addComment` / `deleteComment` siblings.

### 2. `WidgetService` — four new functions

File: `src/api/services/WidgetService.ts`

**`listDoneTickets(projectId, widgetUserId?)`** — mirrors `listTickets()` but:
- filter `eq(workspaceTasks.status, 'done')`
- sort `desc(workspaceTasks.completedAt)`
- limit 20
- returns the same response envelope shape (`{ projectName, projectSlug, homepageUrl, position, isIdentified, tickets }`)

**`addWidgetComment(projectId, ticketId, widgetUserId, content, attachments?)`** — authorization wrapper:
- looks up the ticket via `getPublicTicketDetail`-style visibility check; throws `'Ticket not found'` if invisible to this widget user
- delegates to `WorkspaceTaskService.addComment` with `createdByType: 'external'`, `createdById: widgetUserId`, `createdByName: <display name from widget token>`
- returns the new comment in the same shape that `getPublicTicketDetail` returns comments (via `mapCommentToWidgetResponse`, which must be extracted from its current inline usage so it can be reused).

**`updateWidgetComment(projectId, ticketId, commentId, widgetUserId, content)`** — authorization wrapper:
- loads the comment row, verifies `createdByType === 'external'` and `createdById === widgetUserId`
- if not owner → throw `'Not the comment author'`
- delegates to `WorkspaceTaskService.updateComment`

**`deleteWidgetComment(projectId, ticketId, commentId, widgetUserId)`** — authorization wrapper:
- same ownership check as update
- delegates to `WorkspaceTaskService.deleteComment`

**`addWidgetCommentAttachment(projectId, ticketId, commentId, widgetUserId, file)`** — reuses the attachment-upload machinery already used by ticket attachments (`POST /api/widget/tickets/:id/attachments`), but with `ownerType: 'comment'` and `ownerId: commentId`. The ownership check is the same as update/delete.

### 3. HTTP routes — five new endpoints

File: `src/api/HttpServer.ts`

Append after the existing `/api/widget/tickets/:id/attachments` block:

```typescript
app.get('/api/widget/tickets/updates', async (c) => {
  const auth = await WidgetService.authenticateWidget(c.req);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  const result = await WidgetService.listDoneTickets(auth.projectId, auth.widgetUserId);
  return c.json(result);
});

app.post('/api/widget/tickets/:id/comments', async (c) => {
  const auth = await WidgetService.authenticateWidget(c.req);
  if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'Unauthorized — signed token required' }, 401);
  const body = await c.req.json();
  try {
    const comment = await WidgetService.addWidgetComment(auth.projectId, c.req.param('id'), auth.widgetUserId, body.content);
    return c.json({ comment }, 201);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg === 'Ticket not found') return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 400);
  }
});

app.patch('/api/widget/tickets/:id/comments/:commentId', async (c) => {
  const auth = await WidgetService.authenticateWidget(c.req);
  if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json();
  try {
    const comment = await WidgetService.updateWidgetComment(auth.projectId, c.req.param('id'), c.req.param('commentId'), auth.widgetUserId, body.content);
    return c.json({ comment });
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg === 'Ticket not found' || msg === 'Comment not found') return c.json({ error: msg }, 404);
    if (msg === 'Not the comment author') return c.json({ error: msg }, 403);
    return c.json({ error: msg }, 400);
  }
});

app.delete('/api/widget/tickets/:id/comments/:commentId', async (c) => {
  const auth = await WidgetService.authenticateWidget(c.req);
  if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
  try {
    await WidgetService.deleteWidgetComment(auth.projectId, c.req.param('id'), c.req.param('commentId'), auth.widgetUserId);
    return c.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg === 'Comment not found') return c.json({ error: msg }, 404);
    if (msg === 'Not the comment author') return c.json({ error: msg }, 403);
    return c.json({ error: msg }, 400);
  }
});

app.post('/api/widget/tickets/:id/comments/:commentId/attachments', async (c) => {
  const auth = await WidgetService.authenticateWidget(c.req);
  if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const formData = await c.req.raw.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return c.json({ error: 'No file provided' }, 400);
    const attachment = await WidgetService.addWidgetCommentAttachment(
      auth.projectId, c.req.param('id'), c.req.param('commentId'), auth.widgetUserId, file,
    );
    return c.json({ attachment }, 201);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg === 'Comment not found') return c.json({ error: msg }, 404);
    if (msg === 'Not the comment author') return c.json({ error: msg }, 403);
    return c.json({ error: msg }, 400);
  }
});
```

### 4. Response shape for `comment`

The widget already consumes comments as `{ id, body, authorName, createdAt, updatedAt, attachments }` (see `WidgetService.ts` line 453–459). All four comment-mutation endpoints return the same shape, extended with:

- `createdByType: 'external' | 'member'` — origin tag (today always `'external'` for widget-posted comments; `'member'` appears when RunHQ-posted comments are rendered in the widget timeline, or in Ship-2 when RunHQ users post from the widget)
- `externalUserId: string | null` — the `widget_users.externalUserId` of the author when `createdByType === 'external'`; null otherwise
- `isAuthorOfCurrentUser: boolean` — for showing edit/delete affordances
- `canEdit: boolean` — forward-compatible gate (today equals `isAuthorOfCurrentUser`)

The same shape change applies to the comment objects inside `getPublicTicketDetail`'s response, plus the ticket-level `createdByType` / `externalUserId` on ticket responses (same fields, same semantics — needed so the Updates tab cards and the ticket detail view can render `app-user (id:…)` for the *ticket author* too, not only commenters).

## Widget Frontend Changes (`/app/data/home/be/public/widget.js`)

### Tab state expansion

Replace the binary `activeTab = "all" | "mine"` (line 26) with a three-way enum:

```javascript
var activeTab = "updates"; // "updates" | "all" | "mine"
```

`"updates"` becomes the default active tab on open.

### New display-name helper

Added near the other formatters (next to `formatDate` / `formatDuration`):

```javascript
function formatAuthorName(authorName, externalUserId, createdByType) {
  if (createdByType === 'member') return authorName || 'RunHQ member';
  // createdByType === 'external' or null
  if (authorName && externalUserId) return authorName + ' (app-user id:' + externalUserId + ')';
  if (authorName) return authorName;
  if (externalUserId) return 'app-user (id:' + externalUserId + ')';
  return 'Anonymous';
}
```

Replaces every current fallback to `"Anonymous"` in comment rendering (line 1084) and in ticket meta / card rendering (everywhere `createdByName` is displayed). All ticket and comment payloads are extended with `externalUserId` and `createdByType` so this helper has what it needs.

### New API stub

Beside the existing `loadTickets` / `loadMySubmissions` (line 107/115) add:

```javascript
function loadUpdates() { return api("/api/widget/tickets/updates"); }
function postComment(ticketId, content) {
  return api("/api/widget/tickets/" + ticketId + "/comments", { method: "POST", body: { content: content } });
}
function editComment(ticketId, commentId, content) {
  return api("/api/widget/tickets/" + ticketId + "/comments/" + commentId, { method: "PATCH", body: { content: content } });
}
function removeComment(ticketId, commentId) {
  return api("/api/widget/tickets/" + ticketId + "/comments/" + commentId, { method: "DELETE" });
}
function uploadCommentAttachment(ticketId, commentId, file) {
  var formData = new FormData();
  formData.append("file", file);
  return fetch(RUNHQ_API + "/api/widget/tickets/" + ticketId + "/comments/" + commentId + "/attachments", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.token },
    body: formData,
  }).then(handleResponse);
}
```

Add a module-level cache variable: `var updatesCache = null;`.

### `renderTabs()` — extended to three buttons

File: `public/widget.js` lines 1302–1316. Add a third button `"Updates"` at the front. Signature changes to `renderTabs(onTabChange, myCount, currentTab)` so each caller can pass the current tab explicitly (the current use of the module-level `activeTab` stays fine as a fallback). The three buttons render in order: Updates, Recent Tickets, My Tickets. The `rw-tab-btn` / `rw-tab-active` styles already support any count.

### Visibility: show tabs even when unidentified

Today `renderCurrentTab()` and `showMySubmissionsView()` only append `renderTabs()` when `isIdentified` is true (line 1635, 1673). That wraps changes to:

```javascript
// Always render tabs. My Tickets button is disabled when unidentified.
container.appendChild(renderTabs(function (tab) { /* ... */ }, mySubmissionsCountCache));
```

`renderTabs` renders the My Tickets button with a `disabled` attribute + a muted style when `!isIdentified`. Clicking it (in the disabled state) is a no-op; hover tooltip reads "Log in to view your tickets".

### New view: `showUpdatesView()`

New function, mirroring `renderCurrentTab` / `showMySubmissionsView` structure:

```javascript
function showUpdatesView(isIdentified) {
  if (updatesCache) {
    renderUpdatesView(isIdentified);
    return;
  }
  setBodyContent(renderLoading());
  loadUpdates().then(function (data) {
    updatesCache = data.tickets || [];
    renderUpdatesView(isIdentified);
  }).catch(function (err) {
    setBodyContent(renderNotice("error", "Could not load updates: " + err.message));
  });
}

function renderUpdatesView(isIdentified) {
  var container = h("div", null);
  var statsBanner = renderStats(statsCache);
  if (statsBanner) container.appendChild(statsBanner);

  if (isIdentified) container.appendChild(renderInlineForm(submitSuggestion));
  else container.appendChild(renderLoginPrompt());
  container.appendChild(h("hr", { className: "rw-divider" }));

  container.appendChild(renderTabs(handleTabChange, mySubmissionsCountCache, "updates"));
  container.appendChild(renderUpdatesList(updatesCache));
  setBodyContent(container);
}
```

The tab-change callback is factored out (once) into a shared function `handleTabChange(tab)` at module scope, called by all three views:

```javascript
function handleTabChange(tab) {
  activeTab = tab;
  var isIdentified = !!config.isIdentified;
  if (tab === "updates") showUpdatesView(isIdentified);
  else if (tab === "mine") showMySubmissionsView(isIdentified);
  else renderCurrentTab(isIdentified);
}
```

Currently the callback is inlined three different times (once per view). Extraction is incidental cleanup justified by the fact that each view will now have three branches instead of two.

### New list renderer: `renderUpdatesList(tickets)`

Similar to `renderMySubmissions()`, but each card shows:

- Title (`rw-submission-title`)
- Description excerpt (first ~140 chars, `rw-submission-desc`)
- Green "Done" badge (same style as the existing status badge, `statusColor="#10b981"`)
- Relative time: "Shipped 3d ago" derived from `completedAt` via a new `formatRelativeTime(date)` helper (analogous to the existing `formatDuration`). Buckets: `< 1 min` → "just now"; `< 60 min` → "Xm ago"; `< 24h` → "Xh ago"; `< 30d` → "Xd ago"; else absolute date (e.g., "12 Mar 2026"). Prefixed with "Shipped " in the Updates context.
- Empty state: "Nothing shipped yet."
- Clicking opens `showTicketDetail(ticket.id)` — no change to the detail view navigation.

### Back-button / cache invalidation

When `showTicketDetail`'s back button is clicked (line 919 in current code), it currently resets `ticketsCache = null` and calls `showPanelView()`, which re-renders whichever tab was active. That logic expands to also reset `updatesCache = null` so returning to Updates after editing a ticket re-fetches. Concretely:

```javascript
onClick: function () {
  ticketsCache = null;
  mySubmissionsCountCache = null;
  updatesCache = null;
  if (activeTab === "updates") showUpdatesView(!!config.isIdentified);
  else if (activeTab === "mine") showMySubmissionsView(!!config.isIdentified);
  else showPanelView();
}
```

### Comment composer in the detail view

Currently `renderTicketDetail` ends after the timeline. Append a composer section when `config.isIdentified`:

```javascript
// Composer (appended after the timeline block, still inside container)
if (config.isIdentified) {
  container.appendChild(renderCommentComposer(ticket.id));
} else {
  container.appendChild(h("div", { className: "rw-login-prompt" }, "Log in to comment"));
}
```

`renderCommentComposer(ticketId)` renders:

- A `<textarea>` with `placeholder="Add a comment…"`, `maxlength="2000"` (matches ticket description limit)
- An image upload button (paperclip icon, reusing the ticket-form styling — `rw-inline-attach-btn`) and a thumbnail preview strip (`rw-attach-preview`)
- A Submit button. Pressing it:
  1. Calls `postComment(ticketId, content)` → obtain `{ comment }`
  2. For each pending attachment, calls `uploadCommentAttachment(ticketId, comment.id, file)` sequentially
  3. Reloads the detail via `showTicketDetail(ticketId)` on success
  4. On error: renders an inline error notice in the composer; the typed content stays.

### Edit & delete on existing comments

Inside the timeline rendering (line 1080–1100), every `item.kind === "comment"` now renders an action bar **only when** `config.isIdentified && item.isAuthorOfCurrentUser` (a new boolean on the comment payload set by the backend based on `createdByType === 'external' && createdById === widgetUserId`):

- **Edit** button — swaps the comment body for an inline textarea with Save/Cancel. Save calls `editComment()`; Cancel restores. Attachments are out of scope for the edit path (a future enhancement); editing content-only is explicit in this release.
- **Delete** button — shows an inline confirm ("Delete this comment? Cancel / Delete") matching the existing ticket-delete-confirm pattern at line 1019–1045. On confirm → `removeComment()` → `showTicketDetail(ticketId)`.

### "(edited)" marker

In the timeline date rendering (around line 1085, the `rw-timeline-date` span), when the comment has `updatedAt` strictly greater than `createdAt` (compared as ISO strings then fallback to Date.parse), append a small `(edited)` span with:

```javascript
h("span", {
  className: "rw-edited-marker",
  title: "Edited at " + formatDate(item.updatedAt),
}, " (edited)")
```

CSS rule (added to the style-string block that already constructs rules via `textMuted` JS variable — line ~656–704):

```javascript
".rw-edited-marker{color:" + textMuted + ";font-size:11px;margin-left:4px;cursor:help}"
```

The hover tooltip is the native `title` attribute — no tooltip library.

### New CSS rules

Added in the style block (around line 656–704):

- `.rw-tab-btn:disabled { opacity: 0.5; cursor: not-allowed; }` — disabled My Tickets button when unidentified
- `.rw-edited-marker` — muted "(edited)" marker
- `.rw-comment-composer` — composer container spacing
- `.rw-comment-actions` — edit/delete button row inside a timeline card
- `.rw-comment-edit-form` — inline edit textarea + save/cancel row

### Comment payload: adding `isAuthorOfCurrentUser` + `canEdit`

The existing comment response shape `{ id, body, authorName, createdAt, updatedAt, attachments }` is extended with two booleans:

- `isAuthorOfCurrentUser: boolean` — `createdByType === 'external' && createdById === widgetUserId`
- `canEdit: boolean` — redundant today (equals `isAuthorOfCurrentUser`) but added as a forward-compatible gate (future: admins delete any comment)

Emitted by `getPublicTicketDetail` (for the detail view) and by `addWidgetComment` / `updateWidgetComment` (for optimistic refreshes). The widget reads both.

## Testing Plan

### Backend — `src/api/services/WidgetService.updates-tab.test.ts`

- `listDoneTickets` returns only `status='done'`, public, visible-to-widget tickets; sorted by `completedAt desc`; limit 20
- `listDoneTickets` excludes cancelled, private, soft-deleted, and non-visible tickets
- `listDoneTickets` returns `projectName`, `projectSlug`, `homepageUrl`, `isIdentified`, `position`, `tickets` (same envelope as `listTickets`)

### Backend — `src/api/services/WidgetService.comments.test.ts`

- `addWidgetComment` creates a comment with `createdByType='external'`, `createdById=widgetUserId`
- `addWidgetComment` throws `'Ticket not found'` when ticket isn't visible to the widget (wrong project, private, different server)
- `updateWidgetComment` allows the original author to edit, bumps `updatedAt`
- `updateWidgetComment` throws `'Not the comment author'` when widgetUserId doesn't match
- `updateWidgetComment` throws `'Not the comment author'` when `createdByType === 'member'` even if IDs collide
- `deleteWidgetComment` soft-deletes via `deletedAt`, author-only
- Comments posted via widget appear in `listComments(taskId)` alongside RunHQ-app comments — single source of truth assertion
- `getPublicTicketDetail` populates `isAuthorOfCurrentUser` correctly for the current widget user and false for other users

### Backend — `src/api/HttpServer.widget-comments.test.ts`

- 401 on the POST/PATCH/DELETE routes without a signed token
- 403 on PATCH/DELETE by a non-author widget user
- 404 on PATCH/DELETE of a non-existent / already-deleted comment
- Happy path: POST returns 201 + comment; PATCH returns 200 + updated comment with `updatedAt > createdAt`; DELETE returns 200 and subsequent GET no longer includes the comment
- Comment and ticket responses include `createdByType` and `externalUserId`
- `listComments(taskId)` returns mixed `external` + `member` comments when both surfaces have posted; the widget renderer can distinguish them

### Widget (manual QA)

The widget is not unit-tested in isolation today. Manual test checklist covered by a Playwright-style E2E in `e2e/widget-updates-and-comments.spec.ts` (new file), with scenarios:

1. Tabs appear when unidentified; Updates and Recent Tickets load; My Tickets button is disabled
2. After login, My Tickets becomes enabled; clicking it loads the list
3. Updates list shows only done tickets, sorted by completedAt desc; clicking opens detail
4. In a detail view: comment composer renders, posting adds to the timeline, returning to Updates preserves state
5. Editing own comment: body updates, "(edited)" appears, hover shows timestamp
6. Deleting own comment: confirmation → removed from timeline
7. Cross-surface persistence: post in widget → observable in RunHQ app task detail (and vice versa)

## Implementation Sequence

Each step is independently shippable behind `git commit` boundaries.

**Phase 1 — Backend scaffolding (no widget changes yet)**

1. Add `WorkspaceTaskService.updateComment()` + unit test
2. Add `WidgetService.listDoneTickets()` + unit test
3. Add `WidgetService.addWidgetComment` / `updateWidgetComment` / `deleteWidgetComment` / `addWidgetCommentAttachment` + unit tests
4. Extend `getPublicTicketDetail` comment-mapping to include `isAuthorOfCurrentUser` / `canEdit` + unit test (backwards-compatible — widget doesn't read these fields yet)
5. Wire the five new HTTP routes in `HttpServer.ts` + integration tests (401 / 403 / 404 / 200)

**Phase 2 — Widget: Updates tab**

6. Add `loadUpdates` API stub, `updatesCache`, `showUpdatesView`, `renderUpdatesView`, `renderUpdatesList` in `widget.js`
7. Expand `activeTab` to the three-way enum; default to `"updates"` on open
8. Extend `renderTabs` to a three-button layout; add `disabled` state for My Tickets when unidentified
9. Update `renderCurrentTab` / `showMySubmissionsView` / back-button handler to account for the new `updates` state + cache
10. Always-render-tabs: remove the `if (isIdentified)` gate around `renderTabs` in both existing views
11. Manual QA in preview + deploy to staging

**Phase 3 — Widget: Comment composer, edit, delete**

12. Add comment API stubs (`postComment`, `editComment`, `removeComment`, `uploadCommentAttachment`) in `widget.js`
13. Add `renderCommentComposer(ticketId)` + CSS; integrate into `renderTicketDetail`
14. Add edit/delete action bar + inline edit form + "(edited)" marker in the timeline rendering block
15. E2E test: `e2e/widget-updates-and-comments.spec.ts`
16. Manual QA + deploy

## Out of Scope (Ship-1)

- Threaded comment replies
- Mention / notification system
- Attachment editing (replacing files on an existing comment); users delete-and-repost
- Cancelled tickets in Updates (user explicitly chose "done only")
- Pagination on Updates (limit 20 is fixed in v1; "Show more" is a future enhancement)
- Rate limiting on comment posts (existing widget infrastructure handles abuse at a coarser level; add if we see abuse)
- RunHQ-native login / voting / commenting (Ship-2, designed in the appendix below)

---

# Appendix — Ship-2: RunHQ-native Login + Widget Visibility Setting

**Status:** Designed, not in the immediate implementation run. Ship after Ship-1 has been deployed and validated.

## Ship-2 Goals

**RunHQ-native login flow** — let visitors authenticate with their RunHQ identity (instead of, or in addition to, the embedding app's JWT) to gain comment / vote privileges on widgets whose channel they have permission on. Reuses the existing `comment_todo` / `upvote_todo` permission flags from `packages/protocol/src/index.ts:1267–1268`.

Anonymous widget visibility is already governed by the existing `isPublic` flag (Mode 1 of `authenticateWidget`) — no new toggle is introduced in Ship-2. The UI help text for `isPublic` is updated to reflect that it also controls widget visibility to anonymous visitors, in addition to enabling the public project page.

## Ship-2 — RunHQ Login

### Authorization model

The widget project is tied to a channel (`widget_projects.channel_id`). The channel lives on a specific workspace server (Fly machine) and has role-based permissions managed by `RoleService`. A RunHQ user is allowed to comment on a widget iff, on the widget's channel:

- Their (role-aggregated + everyone-role) permission set has `comment_todo: true` (for commenting)
- Or `upvote_todo: true` (for voting)

Server membership alone is not sufficient; a server member with a role that lacks these flags cannot comment. The everyone-role fallback means channels that grant everyone `comment_todo` will let any server member comment without any explicit role assignment.

### Cross-service architecture

Permissions are the workspace server's source of truth; the widget (BE) cannot check them locally. The flow delegates to the workspace server at login, snapshots the permissions, and bakes them into a short-lived JWT the BE trusts. Standard OAuth 2.0 authorization-code flow, adapted for widget-popup embedding.

```
[Widget]                 [BE]                     [Workspace Server]
   │                      │                              │
   │ popup /widget/oauth  │                              │
   ├─────────────────────▶│                              │
   │                      │ redirect /oauth/authorize    │
   │                      ├─────────────────────────────▶│
   │                      │                              │ (user logs in on
   │                      │                              │  workspace-server
   │                      │                              │  if not already)
   │                      │                              │
   │                      │ code + user-info + perms     │
   │                      │◀─────────────────────────────┤
   │                      │                              │
   │                      │ signed widget JWT (w/ perms) │
   │ postMessage(token)   │                              │
   │◀─────────────────────┤                              │
   │ (widget stores in    │                              │
   │  sessionStorage)     │                              │
```

**Why the BE sits in the middle:** the widget's JWT must be signed by the same key the BE uses to authenticate widget requests (`widget_projects.apiSecretHash`), and the BE is the only party that holds that key. The workspace server is the only party that can verify identity + permissions. Neither can do the whole job alone.

### New endpoints

**On the BE:**
- `GET /api/widget/oauth/start?project_slug=...&redirect_origin=...` — initiates the flow; redirects the popup to the workspace server
- `GET /api/widget/oauth/callback?code=...&state=...` — exchanges the workspace-server code for user info + permissions, issues a widget JWT, and `postMessage`s it to the opener (via a tiny HTML page that runs `window.opener.postMessage`)

**On the workspace server (`/app/data/home/runhq/server`):**
- `GET /oauth/authorize?client=widget&project_slug=...&redirect=...` — shows login page if needed, then redirects back to the BE's callback with a short-lived auth code
- `POST /oauth/token` — S2S endpoint; BE exchanges `code` for `{ userId, userName, permissions: { comment_todo, upvote_todo } }` scoped to the widget's channel

### JWT claim extension

The widget JWT gains:

```typescript
type: 'runhq_user',           // instead of 'widget_user'
sub: string,                  // RunHQ user id (prefixed 'runhq:' to avoid collision with external ids)
name: string,                 // RunHQ display name
perms: {                      // snapshotted at token-issue time
  comment_todo: boolean,
  upvote_todo: boolean,
},
exp: <now + 1h>,
```

`authenticateWidget` (new Mode 4) recognizes `type: 'runhq_user'`, upserts a `widget_users` row with `externalUserId: "runhq:<user-id>"` so comments are attributable, and attaches `perms` to the `WidgetAuthResult`. Per-endpoint authorization then checks the relevant perm flag.

### Author display for RunHQ-authed users

When the widget renders a comment with `createdByType: 'member'` (used going forward for RunHQ-authed widget posts), display is the RunHQ name only: `"Alice"` — no `(id:…)` annotation. Contrast with `'external'`: `"Alice (app-user id:u_abc123)"`. This makes the two classes of commenter visually distinct.

### Widget UI changes

- In the comment composer and below the vote buttons, when unidentified: add a "Log in with RunHQ" button alongside the existing "Log in to comment / vote" prompt.
- Clicking it opens a popup at `{BE_ORIGIN}/api/widget/oauth/start?project_slug=...&redirect_origin={window.origin}`.
- Widget listens for `postMessage` events with `{type: 'runhq_widget_token', token}` from the BE origin, stores the token in `sessionStorage` keyed by project slug, and re-renders as identified.
- Token refresh on widget load: if a stored token is within 5 minutes of expiry, silently re-open the flow in a hidden iframe (fails gracefully to "please log in again" if the workspace session expired).

### Security considerations

- `state` parameter on the OAuth flow prevents CSRF
- `redirect_origin` is validated against an allowlist (the widget project's known embed origins, tracked via a new nullable `allowed_origins` column on `widget_projects`)
- `postMessage` target origin is strictly checked on both sides
- Permission snapshot has a 1-hour TTL; revocation is eventually-consistent within that window (acceptable trade-off to avoid per-request S2S calls)
- Widget-tokens tied to RunHQ users are single-server-scoped (can't be reused on a different widget project even with the same RunHQ user)

## Ship-2 — `isPublic` help-text update

In `/app/data/home/runhq/client/src/pages/ProjectSettingsPage.tsx` (line ~915), update the help text under the "Make project public" toggle to reflect that it also enables anonymous widget visibility:

> "Allow anyone to view and vote on tickets via a public project page and via the embeddable widget (no login required)."

No schema change. No auth logic change. Just a clearer label so project owners know what the toggle actually governs.

## Ship-2 Testing

- OAuth flow E2E: successful login → token in widget → commenting works
- Permission failures: user with `comment_todo=false` → 403 on comment POST
- Permission failures: user without server membership → 401 at OAuth callback
- Token expiry & refresh: stored token just past expiry → silent refresh path
- `postMessage` origin validation: foreign origin → token rejection
- Author display: RunHQ-authed comment renders as `"Alice"`; external-authed comment renders as `"Alice (app-user id:…)"`
