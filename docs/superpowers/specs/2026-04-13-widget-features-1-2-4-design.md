# Widget Features #1, #2, #4 — Design Spec

**Date:** 2026-04-13
**Repos:** `/app/data/home/be`, `/app/data/home/homepage`, `/app/data/home/runhq` (server + client)

## Overview

Three widget features building on the existing BE widget tables and API routes (WidgetService.ts, HttpServer.ts widget routes):

1. **Public project page** at `runhq.io/project/:slug`
2. **Ticket-to-todo sync** (BE <-> Fly server)
3. **Public/private project toggle**

## Feature #4 — Public/Private Project Toggle

### Schema Change

Add `isPublic` boolean column to `widget_projects` table, default `false`.

```typescript
// In src/db/schema.ts, widget_projects table
isPublic: boolean('is_public').default(false).notNull(),
```

### BE Changes (src/api/services/WidgetService.ts)

- `authenticateWidget()`: In the public slug mode branch (no Authorization header, uses X-RW-Project), add a check: if the project exists but `isPublic === false`, return `null` (same as project-not-found). This gates all public API access behind the toggle.
- `getWidgetSettings()`: Include `is_public` in the returned settings object.
- `updateWidgetSettings()`: Accept `is_public` in the settings update payload.

### BE Route Changes (src/api/HttpServer.ts)

- `GET /api/widget/settings`: Response now includes `is_public: boolean`.
- `PUT /api/widget/settings`: Accepts `is_public` in request body.

### Client Changes (runhq/client/src/pages/ProjectSettingsPage.tsx)

Add an "Make project public" checkbox in the widget settings section, same pattern as the existing auto-approve checkbox:

```jsx
<label className="flex items-center gap-2 cursor-pointer">
  <input type="checkbox" checked={state.isPublic} onChange={...} className="..." />
  <span className="text-sm text-white">Make project public</span>
</label>
<p className="text-xs text-slate-500 mt-1 ml-6">
  Allow anyone to view and vote on tickets at runhq.io/project/{slug}.
</p>
```

Wire through the existing `PUT /api/widget/settings` endpoint alongside `auto_approve`, `widget_position`, `voting_period_hours`.

## Feature #1 — Public Project Page

### Tech Stack Context

The homepage app (`/app/data/home/homepage`) is a Vite + React 18 SPA with React Router v7, Tailwind CSS, and zero existing API integration.

### New Route

Add `/project/:slug` route in `App.tsx` mapping to a new `ProjectPage.tsx` in `src/pages/`.

### API Integration

Add a `VITE_API_URL` environment variable (default: `https://console.runhq.io`) for the BE API base URL.

Fetch on mount:
```typescript
GET {VITE_API_URL}/api/widget/tickets
Headers: { 'X-RW-Project': slug }
```

The existing public slug auth mode in WidgetService handles this — no Authorization header needed. Returns `{ projectName, position, isIdentified, tickets[] }`.

### Page Behavior

- **Loading state**: Spinner while fetching.
- **Error/404**: If the fetch returns 401 (project not found or not public) or network error, show a "Project not found" page.
- **Success**: Render the project name as heading, then a list of tickets.

### Ticket Display

Each ticket shows:
- **Title** and **description** (truncated if long)
- **Vote counts**: yes votes / no votes with thumbs up/down icons
- **Status badge**: color-coded pill (`pending`, `planned`, `in_progress`, `needs_review`, `done`, `cancelled`)

Only approved (`moderationStatus === 'approved'`) and non-private (`isPrivate === false`) tickets are shown — this filtering already happens in `WidgetService.listTickets()` for public slug mode.

### Styling

Match the existing homepage design system:
- Dark theme: `bg-slate-900`, `text-white`, `text-slate-300`
- Card style: `bg-slate-800/50 border border-slate-700/50 rounded-xl`
- Accent: `text-cyan-400`, `bg-cyan-500`
- Status badge colors mapped per status

### No Layout Change

The `/project/:slug` route uses the same Layout wrapper as other pages (shared nav + scroll-to-top).

## Feature #2 — Ticket-to-Todo Sync

### Architecture

Follows the existing GitVote `pollMissedEvents()` pattern:
- **Push** on ticket creation (BE -> Fly server via `fetchFromServer`)
- **Pull** on server wake (Fly server -> BE to get unsynced tickets)
- **Status sync** back (Fly server -> BE when todo status changes)

### Schema Changes

#### BE: `widget_tickets` table additions

```typescript
syncStatus: text('sync_status').$type<'synced' | 'pending'>().default('pending').notNull(),
flyTodoId: text('fly_todo_id'),  // Fly-side todo ID for status sync back
```

#### Fly Server: `todos` table

Extend the existing `sourceType` column type to include `'widget'`:
```typescript
sourceType: text('source_type').$type<'native' | 'gitvote' | 'widget'>().default('native'),
```

The existing `sourceId` and `sourceUrl` columns will store the widget ticket ID and a link back to the public project page.

### Push: BE -> Fly Server on Ticket Creation

**Location:** `WidgetService.createTicket()`

After inserting the ticket:
1. Look up the widget project to get `serverId` and `channelId`.
2. Look up the server record from the `servers` table.
3. Call `fetchFromServer(server, systemUserId, '/api/todos', { method: 'POST', body: { title, description, channelId, sourceType: 'widget', sourceId: ticketId } })`.
4. On success: set `syncStatus = 'synced'` and store `flyTodoId` from the response.
5. On failure (server down, timeout): leave `syncStatus = 'pending'`. Log warning.

**System user ID:** The BE needs a userId for `fetchFromServer` to generate a session JWT. Use the server owner's userId from the server record (`servers.ownerId`).

### Pull: Fly Server Fetches Unsynced Tickets on Wake

**New BE endpoint:** `GET /api/widget/tickets/unsynced?serverId={serverId}`

- Auth: Server token (`X-Server-Token` header) — same pattern as heartbeat/register.
- Returns all widget tickets where `syncStatus = 'pending'` for widget projects belonging to the given `serverId`.
- Response: `{ tickets: [{ id, title, description, projectId, channelId }] }`

**New BE endpoint:** `POST /api/widget/tickets/mark-synced`

- Auth: Server token.
- Body: `{ ticketIds: string[], flyTodoIds: Record<string, string> }` — maps ticket IDs to their created Fly todo IDs.
- Sets `syncStatus = 'synced'` and `flyTodoId` for each ticket.

**Fly server startup** (`src/http/server.ts`, alongside `pollMissedEvents`):

```typescript
if (cloudApiUrl) {
  syncWidgetTickets().catch(err => {
    console.error('[Server] Failed to sync widget tickets:', err);
  });
}
```

The `syncWidgetTickets()` function:
1. `GET {CLOUD_API_URL}/api/widget/tickets/unsynced?serverId={serverId}` with server token auth.
2. For each ticket, create a todo via `todoService.create({ title, description, channelId, sourceType: 'widget', sourceId: ticketId })`.
3. Collect the created todo IDs.
4. `POST {CLOUD_API_URL}/api/widget/tickets/mark-synced` with the mapping.

### Status Sync: Fly Server -> BE

**New BE endpoint:** `PATCH /api/widget/tickets/:id/status`

- Auth: Server token.
- Body: `{ status: 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled' }`
- Updates the widget ticket's `status` field.

**Fly server event listener** (in server startup or a new WidgetSyncService):

Listen on the `todo:change` event bus:
```typescript
eventBus.on('todo:change', (todo, action, meta) => {
  if (
    action === 'updated' &&
    todo.sourceType === 'widget' &&
    todo.sourceId &&
    meta?.oldStatus &&
    !meta?.fromSync
  ) {
    syncStatusToBE(todo.sourceId, todo.status).catch(err =>
      console.error('[WidgetSync] Failed to sync status to BE:', err)
    );
  }
});
```

`syncStatusToBE()` calls `PATCH {CLOUD_API_URL}/api/widget/tickets/{sourceId}/status` with the server token.

### Status Mapping

Widget ticket and Fly todo share the same status enum (`pending`, `planned`, `in_progress`, `needs_review`, `done`, `cancelled`), so it's a 1:1 mapping — no translation needed.

### Loop Prevention

Same pattern as GitVote: when the Fly server creates todos from synced tickets, emit with `{ fromSync: true }` to prevent the event listener from syncing status back immediately.

## Files Changed Summary

| Repo | File | Change |
|------|------|--------|
| BE | `src/db/schema.ts` | Add `isPublic` to `widget_projects`, add `syncStatus` + `flyTodoId` to `widget_tickets` |
| BE | `src/api/services/WidgetService.ts` | Gate public auth on `isPublic`, add sync logic in `createTicket`, expose `isPublic` in settings |
| BE | `src/api/HttpServer.ts` | Add unsynced tickets endpoint, mark-synced endpoint, ticket status update endpoint; update settings routes for `isPublic` |
| Homepage | `src/App.tsx` | Add `/project/:slug` route |
| Homepage | `src/pages/ProjectPage.tsx` | New file: public project page |
| Homepage | `.env` / `.env.example` | Add `VITE_API_URL` |
| Fly Server | `src/db/schema.ts` (or equivalent) | Extend `sourceType` to include `'widget'` |
| Fly Server | `src/http/server.ts` | Add `syncWidgetTickets()` call on startup |
| Fly Server | New: widget sync logic | `syncWidgetTickets()` function + event listener for status sync back |
| Client | `src/pages/ProjectSettingsPage.tsx` | Add "Make project public" checkbox in widget settings |
