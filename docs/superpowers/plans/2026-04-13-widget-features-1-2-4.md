# Widget Features #1, #2, #4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public project page, ticket-to-todo sync, and public/private project toggle to the RunHQ widget system.

**Architecture:** Three features across four codebases. Feature #4 (isPublic toggle) is a foundation for #1 (public page). Feature #2 (ticket sync) is independent. Build order: #4 first (schema + API + UI), then #1 (public page), then #2 (sync).

**Tech Stack:** Node.js/Hono/Drizzle (BE), Vite/React/Tailwind (homepage + client), SQLite/Hono (Fly server)

**Spec:** `docs/superpowers/specs/2026-04-13-widget-features-1-2-4-design.md`

---

## Task 1: Add `isPublic` column to `widget_projects` schema

**Files:**
- Modify: `/app/data/home/be/src/db/schema.ts:1002-1016`

- [ ] **Step 1: Add the column**

In `src/db/schema.ts`, add `isPublic` to the `widgetProjects` table definition, after the `enabled` column:

```typescript
  enabled: boolean('enabled').default(true).notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  autoApprove: boolean('auto_approve').default(false).notNull(),
```

- [ ] **Step 2: Push schema to database**

Run: `cd /app/data/home/be && pnpm db:push`
Expected: Schema sync succeeds, `is_public` column added to `widget_projects` table.

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add src/db/schema.ts
git commit -m "feat(widget): add isPublic column to widget_projects table"
```

---

## Task 2: Add `syncStatus` and `flyTodoId` columns to `widget_tickets` schema

**Files:**
- Modify: `/app/data/home/be/src/db/schema.ts:1030-1045`

- [ ] **Step 1: Add the columns**

In `src/db/schema.ts`, add `syncStatus` and `flyTodoId` to the `widgetTickets` table definition, after the `votingEndsAt` column:

```typescript
  votingEndsAt: timestamp('voting_ends_at'),
  syncStatus: text('sync_status').$type<'synced' | 'pending'>().default('pending').notNull(),
  flyTodoId: text('fly_todo_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
```

- [ ] **Step 2: Push schema to database**

Run: `cd /app/data/home/be && pnpm db:push`
Expected: Schema sync succeeds, `sync_status` and `fly_todo_id` columns added to `widget_tickets` table.

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add src/db/schema.ts
git commit -m "feat(widget): add syncStatus and flyTodoId columns to widget_tickets"
```

---

## Task 3: Gate public widget auth on `isPublic` flag

**Files:**
- Modify: `/app/data/home/be/src/api/services/WidgetService.ts`

- [ ] **Step 1: Update the public slug auth branch**

In `authenticateWidget()`, the Mode 1 (public slug) branch currently selects `id`, `slug`, `enabled` from `widgetProjects`. Add `isPublic` to the select and add a check. Find this code:

```typescript
  // ---- Mode 1: Public slug (no auth header) ----
  if (!authHeader && projectSlugHeader) {
    const [project] = await db
      .select({ id: widgetProjects.id, slug: widgetProjects.slug, enabled: widgetProjects.enabled })
      .from(widgetProjects)
      .where(eq(widgetProjects.slug, projectSlugHeader))
      .limit(1);

    if (!project || !project.enabled) return null;
    return { projectId: project.id, projectSlug: project.slug };
  }
```

Replace with:

```typescript
  // ---- Mode 1: Public slug (no auth header) ----
  if (!authHeader && projectSlugHeader) {
    const [project] = await db
      .select({ id: widgetProjects.id, slug: widgetProjects.slug, enabled: widgetProjects.enabled, isPublic: widgetProjects.isPublic })
      .from(widgetProjects)
      .where(eq(widgetProjects.slug, projectSlugHeader))
      .limit(1);

    if (!project || !project.enabled || !project.isPublic) return null;
    return { projectId: project.id, projectSlug: project.slug };
  }
```

- [ ] **Step 2: Verify the change compiles**

Run: `cd /app/data/home/be && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to WidgetService.

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts
git commit -m "feat(widget): gate public slug auth on isPublic flag"
```

---

## Task 4: Expose `isPublic` in widget settings API

**Files:**
- Modify: `/app/data/home/be/src/api/services/WidgetService.ts`
- Modify: `/app/data/home/be/src/api/HttpServer.ts`

- [ ] **Step 1: Update `getWidgetSettings` in WidgetService.ts**

Find the `getWidgetSettings` function and add `isPublic` to the select and return. Change:

```typescript
export async function getWidgetSettings(serverId: string) {
  const [project] = await db
    .select({
      autoApprove: widgetProjects.autoApprove,
      widgetPosition: widgetProjects.widgetPosition,
      votingPeriodHours: widgetProjects.votingPeriodHours,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.serverId, serverId))
    .limit(1);

  if (!project) return null;

  return {
    auto_approve: project.autoApprove,
    widget_position: project.widgetPosition,
    voting_period_hours: project.votingPeriodHours,
  };
}
```

To:

```typescript
export async function getWidgetSettings(serverId: string) {
  const [project] = await db
    .select({
      autoApprove: widgetProjects.autoApprove,
      widgetPosition: widgetProjects.widgetPosition,
      votingPeriodHours: widgetProjects.votingPeriodHours,
      isPublic: widgetProjects.isPublic,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.serverId, serverId))
    .limit(1);

  if (!project) return null;

  return {
    auto_approve: project.autoApprove,
    widget_position: project.widgetPosition,
    voting_period_hours: project.votingPeriodHours,
    is_public: project.isPublic,
  };
}
```

- [ ] **Step 2: Update `updateWidgetSettings` in WidgetService.ts**

Change the function signature and set logic. Find:

```typescript
export async function updateWidgetSettings(
  serverId: string,
  settings: {
    auto_approve?: boolean;
    widget_position?: string;
    voting_period_hours?: number;
  }
) {
  await db
    .update(widgetProjects)
    .set({
      ...(settings.auto_approve !== undefined && { autoApprove: settings.auto_approve }),
      ...(settings.widget_position !== undefined && { widgetPosition: settings.widget_position }),
      ...(settings.voting_period_hours !== undefined && { votingPeriodHours: settings.voting_period_hours }),
      updatedAt: new Date(),
    })
    .where(eq(widgetProjects.serverId, serverId));
}
```

Replace with:

```typescript
export async function updateWidgetSettings(
  serverId: string,
  settings: {
    auto_approve?: boolean;
    widget_position?: string;
    voting_period_hours?: number;
    is_public?: boolean;
  }
) {
  await db
    .update(widgetProjects)
    .set({
      ...(settings.auto_approve !== undefined && { autoApprove: settings.auto_approve }),
      ...(settings.widget_position !== undefined && { widgetPosition: settings.widget_position }),
      ...(settings.voting_period_hours !== undefined && { votingPeriodHours: settings.voting_period_hours }),
      ...(settings.is_public !== undefined && { isPublic: settings.is_public }),
      updatedAt: new Date(),
    })
    .where(eq(widgetProjects.serverId, serverId));
}
```

- [ ] **Step 3: Update the PUT settings route in HttpServer.ts**

Find the `PUT /api/widget/settings` route:

```typescript
    const { serverId, auto_approve, widget_position, voting_period_hours } = await c.req.json();
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    await WidgetService.updateWidgetSettings(serverId, { auto_approve, widget_position, voting_period_hours });
```

Replace with:

```typescript
    const { serverId, auto_approve, widget_position, voting_period_hours, is_public } = await c.req.json();
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    await WidgetService.updateWidgetSettings(serverId, { auto_approve, widget_position, voting_period_hours, is_public });
```

- [ ] **Step 4: Verify compilation**

Run: `cd /app/data/home/be && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts src/api/HttpServer.ts
git commit -m "feat(widget): expose isPublic in widget settings GET/PUT"
```

---

## Task 5: Add `isPublic` toggle to client widget settings UI

**Files:**
- Modify: `/app/data/home/runhq/client/src/pages/ProjectSettingsPage.tsx`

- [ ] **Step 1: Add `isPublic` to the widget state interface**

Find the state initialization in `WidgetIntegration`:

```typescript
    widgetPosition: 'middle-right',
    autoApprove: false,
    votingPeriodHours: '',
```

Replace with:

```typescript
    widgetPosition: 'middle-right',
    autoApprove: false,
    isPublic: false,
    votingPeriodHours: '',
```

- [ ] **Step 2: Load `isPublic` from the settings API response**

Find where settings are loaded from the API response (in the `useEffect` that fetches widget status). Look for where `autoApprove` is set from the settings response:

```typescript
            autoApprove: settingsData.data.auto_approve ?? false,
```

Add `isPublic` right after it:

```typescript
            autoApprove: settingsData.data.auto_approve ?? false,
            isPublic: settingsData.data.is_public ?? false,
```

- [ ] **Step 3: Send `isPublic` in the save handler**

Find the `handleSaveSettings` function's fetch body:

```typescript
      body: JSON.stringify({
        serverId: project.serverId,
        auto_approve: state.autoApprove,
        widget_position: state.widgetPosition,
        voting_period_hours: state.votingPeriodHours ? parseInt(state.votingPeriodHours, 10) : null,
      }),
```

Replace with:

```typescript
      body: JSON.stringify({
        serverId: project.serverId,
        auto_approve: state.autoApprove,
        is_public: state.isPublic,
        widget_position: state.widgetPosition,
        voting_period_hours: state.votingPeriodHours ? parseInt(state.votingPeriodHours, 10) : null,
      }),
```

- [ ] **Step 4: Add the checkbox UI**

Add the "Make project public" checkbox right before the auto-approve checkbox. Find:

```typescript
{/* Auto-approve */}
<div>
  <label className="flex items-center gap-2 cursor-pointer">
    <input
      type="checkbox"
      checked={state.autoApprove}
```

Insert this block immediately before it:

```tsx
{/* Public project page */}
<div>
  <label className="flex items-center gap-2 cursor-pointer">
    <input
      type="checkbox"
      checked={state.isPublic}
      onChange={e => setState(s => ({ ...s, isPublic: e.target.checked }))}
      className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
    />
    <span className="text-sm text-white">Make project public</span>
  </label>
  <p className="text-xs text-slate-500 mt-1 ml-6">Allow anyone to view and vote on tickets via a public project page.</p>
</div>
```

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/runhq/client
git add src/pages/ProjectSettingsPage.tsx
git commit -m "feat(widget): add isPublic toggle to widget settings UI"
```

---

## Task 6: Create public project page in homepage app

**Files:**
- Create: `/app/data/home/homepage/src/pages/ProjectPage.tsx`
- Modify: `/app/data/home/homepage/src/App.tsx`

- [ ] **Step 1: Create `ProjectPage.tsx`**

Create `/app/data/home/homepage/src/pages/ProjectPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || 'https://console.runhq.io';

interface Ticket {
  id: string;
  title: string;
  description: string | null;
  status: string;
  yesVotes: number;
  noVotes: number;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-slate-600 text-slate-200',
  planned: 'bg-blue-600/20 text-blue-400 border border-blue-500/30',
  in_progress: 'bg-amber-600/20 text-amber-400 border border-amber-500/30',
  needs_review: 'bg-purple-600/20 text-purple-400 border border-purple-500/30',
  done: 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30',
  cancelled: 'bg-red-600/20 text-red-400 border border-red-500/30',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  planned: 'Planned',
  in_progress: 'In Progress',
  needs_review: 'Needs Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export default function ProjectPage() {
  const { slug } = useParams<{ slug: string }>();
  const [projectName, setProjectName] = useState('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!slug) return;

    fetch(`${API_URL}/api/widget/tickets`, {
      headers: { 'X-RW-Project': slug },
    })
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        const data = await res.json();
        setProjectName(data.projectName || slug);
        setTickets(data.tickets || []);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <h1 className="text-3xl font-bold text-white">Project Not Found</h1>
        <p className="text-slate-400">This project doesn't exist or isn't public.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-white mb-2">{projectName}</h1>
      <p className="text-slate-400 mb-8">{tickets.length} ticket{tickets.length !== 1 ? 's' : ''}</p>

      {tickets.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-slate-500 text-lg">No tickets yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {tickets.map((ticket) => (
            <div
              key={ticket.id}
              className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-white mb-1">{ticket.title}</h3>
                  {ticket.description && (
                    <p className="text-slate-400 text-sm line-clamp-3">{ticket.description}</p>
                  )}
                </div>
                <span className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[ticket.status] || STATUS_COLORS.pending}`}>
                  {STATUS_LABELS[ticket.status] || ticket.status}
                </span>
              </div>

              <div className="flex items-center gap-4 mt-4 text-sm text-slate-400">
                <span className="flex items-center gap-1" title="Yes votes">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z" />
                  </svg>
                  {ticket.yesVotes}
                </span>
                <span className="flex items-center gap-1" title="No votes">
                  <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 15V19a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z" />
                  </svg>
                  {ticket.noVotes}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the route in `App.tsx`**

In `/app/data/home/homepage/src/App.tsx`, add the import at the top with the other page imports:

```typescript
import ProjectPage from './pages/ProjectPage';
```

Add the route inside the `<Routes>` block, after the existing routes:

```tsx
<Route path="/project/:slug" element={<ProjectPage />} />
```

- [ ] **Step 3: Verify the app compiles and renders**

Run: `cd /app/data/home/homepage && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/homepage
git add src/pages/ProjectPage.tsx src/App.tsx
git commit -m "feat: add public project page at /project/:slug"
```

---

## Task 7: Add ticket sync on creation (BE -> Fly server push)

**Files:**
- Modify: `/app/data/home/be/src/api/services/WidgetService.ts`

- [ ] **Step 1: Add imports**

At the top of `WidgetService.ts`, add the server-related imports. Find:

```typescript
import { eq, and, ne, desc, sql, inArray } from 'drizzle-orm';
```

Replace with:

```typescript
import { eq, and, ne, desc, sql, inArray } from 'drizzle-orm';
import { servers } from '../../db/schema';
import { fetchFromServer } from './ServerService';
```

Also update the `widgetTickets` import to include the new columns (no change needed if the schema import already covers all columns).

- [ ] **Step 2: Add sync logic after ticket creation**

In the `createTicket` function, after the ticket is inserted and returned, add the sync push. Find the end of `createTicket`:

```typescript
  const [ticket] = await db
    .insert(widgetTickets)
    .values({
      projectId,
      title,
      description: opts.description,
      isPrivate: opts.isPrivate ?? false,
      widgetUserId: widgetUserId ?? null,
      moderationStatus,
      votingEndsAt,
    })
    .returning();

  return ticket;
}
```

Replace with:

```typescript
  const [ticket] = await db
    .insert(widgetTickets)
    .values({
      projectId,
      title,
      description: opts.description,
      isPrivate: opts.isPrivate ?? false,
      widgetUserId: widgetUserId ?? null,
      moderationStatus,
      votingEndsAt,
    })
    .returning();

  // Best-effort push to Fly server as a todo
  syncTicketToServer(ticket.id, projectId, title, opts.description).catch((err) => {
    console.warn('[WidgetService] Failed to sync ticket to server:', err);
  });

  return ticket;
}

/**
 * Best-effort push: create a todo on the Fly server for a new widget ticket.
 * If the server is down, the ticket stays syncStatus='pending' and will be
 * picked up on the next server wake via the unsynced tickets endpoint.
 */
async function syncTicketToServer(
  ticketId: string,
  projectId: string,
  title: string,
  description?: string,
) {
  // Look up the widget project to get serverId and channelId
  const [wp] = await db
    .select({
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
      slug: widgetProjects.slug,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  if (!wp?.channelId) return;

  // Look up the server record
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, wp.serverId))
    .limit(1);

  if (!server?.ownerId) return;

  const result = await fetchFromServer<{ success: boolean; data?: { id: string } }>(
    server,
    server.ownerId,
    '/api/todos',
    {
      method: 'POST',
      body: {
        title,
        description: description || undefined,
        channelId: wp.channelId,
        sourceType: 'widget',
        sourceId: ticketId,
        sourceUrl: `https://runhq.io/project/${wp.slug}`,
      },
    },
  );

  if (result.success && result.data?.id) {
    await db
      .update(widgetTickets)
      .set({ syncStatus: 'synced', flyTodoId: result.data.id })
      .where(eq(widgetTickets.id, ticketId));
  }
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd /app/data/home/be && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts
git commit -m "feat(widget): push new tickets to Fly server as todos (best-effort)"
```

---

## Task 8: Add BE endpoints for Fly server sync (unsynced tickets + mark-synced + status update)

**Files:**
- Modify: `/app/data/home/be/src/api/HttpServer.ts`

- [ ] **Step 1: Add the unsynced tickets endpoint**

In `HttpServer.ts`, add these three new endpoints in the widget routes section (after the existing management routes, before the closing of the widget section). Add them alongside the other widget routes.

Add the imports if not already present — `WidgetService` is already imported. Ensure `ServerService` is imported too:

```typescript
import * as ServerService from '../services/ServerService';
```

(Check if this import already exists at the top of HttpServer.ts — it likely does.)

Add the endpoints:

```typescript
  // ── Widget Sync Endpoints (Fly server ↔ BE) ──────────────────────
  // Auth: server token (same pattern as heartbeat/register)

  app.get('/api/widget/tickets/unsynced', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const serverId = server.id;
    const tickets = await WidgetService.getUnsyncedTickets(serverId);
    return c.json({ tickets });
  });

  app.post('/api/widget/tickets/mark-synced', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const { ticketIds, flyTodoIds } = await c.req.json();
    if (!Array.isArray(ticketIds)) return c.json({ error: 'ticketIds required' }, 400);

    await WidgetService.markTicketsSynced(ticketIds, flyTodoIds || {});
    return c.json({ success: true });
  });

  app.patch('/api/widget/tickets/:id/status', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const ticketId = c.req.param('id');
    const { status } = await c.req.json();
    if (!status) return c.json({ error: 'status required' }, 400);

    await WidgetService.updateTicketStatus(ticketId, status);
    return c.json({ success: true });
  });
```

- [ ] **Step 2: Commit**

```bash
cd /app/data/home/be
git add src/api/HttpServer.ts
git commit -m "feat(widget): add sync endpoints for Fly server (unsynced, mark-synced, status)"
```

---

## Task 9: Add sync service functions in WidgetService

**Files:**
- Modify: `/app/data/home/be/src/api/services/WidgetService.ts`

- [ ] **Step 1: Add `getUnsyncedTickets`**

Add this function to WidgetService.ts:

```typescript
/**
 * Get all pending-sync tickets for widget projects belonging to a given server.
 * Called by the Fly server on wake to pull tickets it missed while sleeping.
 */
export async function getUnsyncedTickets(serverId: string) {
  const rows = await db
    .select({
      id: widgetTickets.id,
      title: widgetTickets.title,
      description: widgetTickets.description,
      projectId: widgetTickets.projectId,
      channelId: widgetProjects.channelId,
      slug: widgetProjects.slug,
    })
    .from(widgetTickets)
    .innerJoin(widgetProjects, eq(widgetTickets.projectId, widgetProjects.id))
    .where(
      and(
        eq(widgetProjects.serverId, serverId),
        eq(widgetTickets.syncStatus, 'pending'),
      ),
    )
    .limit(200);

  return rows;
}
```

- [ ] **Step 2: Add `markTicketsSynced`**

```typescript
/**
 * Mark tickets as synced and store their Fly-side todo IDs.
 */
export async function markTicketsSynced(
  ticketIds: string[],
  flyTodoIds: Record<string, string>,
) {
  for (const ticketId of ticketIds) {
    await db
      .update(widgetTickets)
      .set({
        syncStatus: 'synced',
        flyTodoId: flyTodoIds[ticketId] || null,
        updatedAt: new Date(),
      })
      .where(eq(widgetTickets.id, ticketId));
  }
}
```

- [ ] **Step 3: Add `updateTicketStatus`**

```typescript
/**
 * Update a ticket's status (called by Fly server when todo status changes).
 */
export async function updateTicketStatus(
  ticketId: string,
  status: 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled',
) {
  await db
    .update(widgetTickets)
    .set({ status, updatedAt: new Date() })
    .where(eq(widgetTickets.id, ticketId));
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd /app/data/home/be && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts
git commit -m "feat(widget): add sync service functions (getUnsynced, markSynced, updateStatus)"
```

---

## Task 10: Extend Fly server `sourceType` to include `'widget'`

**Files:**
- Modify: `/app/data/home/runhq/server/src/db/schema.ts`

- [ ] **Step 1: Update the sourceType type**

Find in the Fly server schema:

```typescript
  sourceType: text('source_type').$type<'native' | 'gitvote'>().default('native'),
```

Replace with:

```typescript
  sourceType: text('source_type').$type<'native' | 'gitvote' | 'widget'>().default('native'),
```

- [ ] **Step 2: Update the TodoStatus type if needed**

Check if `sourceType` is referenced in the server protocol types. If `@runhq/server-protocol` has a `SourceType` type, it needs updating too. Search for `sourceType` in the protocol package and update accordingly.

Run: `grep -r "sourceType\|source_type\|SourceType" /app/data/home/runhq/packages/protocol/src/ 2>/dev/null | head -10`

If there's a type union like `'native' | 'gitvote'`, add `| 'widget'` to it.

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/runhq/server
git add src/db/schema.ts
# If protocol was changed too:
# git add ../../packages/protocol/src/...
git commit -m "feat: extend sourceType to include 'widget' for todo sync"
```

---

## Task 11: Add widget ticket sync on Fly server startup

**Files:**
- Modify: `/app/data/home/runhq/server/src/http/server.ts`

- [ ] **Step 1: Add the sync function and startup call**

In `/app/data/home/runhq/server/src/http/server.ts`, after the `pollMissedEvents` block (around line 115), add the widget sync call:

```typescript
  // Poll for missed GitVote events on startup (fire-and-forget)
  if (integrationService) {
    integrationService.pollMissedEvents().catch((err) => {
      console.error('[Server] Failed to poll missed GitVote events:', err);
    });
  }

  // Sync unsynced widget tickets on startup (fire-and-forget)
  if (todoService && config.cloudApiUrl && config.serverToken) {
    syncWidgetTickets(config, todoService, eventBus).catch((err) => {
      console.error('[Server] Failed to sync widget tickets:', err);
    });
  }
```

Then add the `syncWidgetTickets` function. Place it at the bottom of the file (before any default export) or right above `createHttpServer`:

```typescript
/**
 * On server wake, pull unsynced widget tickets from the BE and create todos.
 * Mirrors the GitVote pollMissedEvents() pattern.
 */
async function syncWidgetTickets(
  config: Config,
  todoService: TodoService,
  eventBus?: ServerEventBus,
) {
  const { cloudApiUrl, serverToken, serverId } = config;
  if (!cloudApiUrl || !serverToken) return;

  // 1. Fetch unsynced tickets from BE
  const res = await fetch(`${cloudApiUrl}/api/widget/tickets/unsynced`, {
    headers: {
      'X-Server-Token': serverToken,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    console.warn(`[WidgetSync] Failed to fetch unsynced tickets: HTTP ${res.status}`);
    return;
  }

  const { tickets } = await res.json() as {
    tickets: Array<{ id: string; title: string; description: string | null; channelId: string | null; slug: string }>;
  };

  if (!tickets || tickets.length === 0) return;

  console.log(`[WidgetSync] Found ${tickets.length} unsynced ticket(s), creating todos...`);

  // 2. Create todos for each ticket
  const syncedIds: string[] = [];
  const flyTodoIds: Record<string, string> = {};

  for (const ticket of tickets) {
    if (!ticket.channelId) continue;
    try {
      const todo = todoService.create(
        {
          title: ticket.title,
          description: ticket.description || undefined,
          channelId: ticket.channelId,
          sourceType: 'widget',
          sourceId: ticket.id,
          sourceUrl: `https://runhq.io/project/${ticket.slug}`,
        },
        serverId,
      );
      eventBus?.emit('todo:change', todo, 'created', { fromSync: true });
      syncedIds.push(ticket.id);
      flyTodoIds[ticket.id] = todo.id;
    } catch (err) {
      console.error(`[WidgetSync] Failed to create todo for ticket ${ticket.id}:`, err);
    }
  }

  if (syncedIds.length === 0) return;

  // 3. Mark tickets as synced in the BE
  try {
    await fetch(`${cloudApiUrl}/api/widget/tickets/mark-synced`, {
      method: 'POST',
      headers: {
        'X-Server-Token': serverToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticketIds: syncedIds, flyTodoIds }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[WidgetSync] Marked ${syncedIds.length} ticket(s) as synced`);
  } catch (err) {
    console.error('[WidgetSync] Failed to mark tickets as synced:', err);
  }
}
```

- [ ] **Step 2: Add necessary imports**

Add at the top of the file (with the existing imports):

```typescript
import type { TodoService } from '../services/TodoService.js';
```

Check if `TodoService` is already imported (it may be via `RouteDeps` or similar). If so, skip this step.

Also ensure `Config` is imported — it already is (`import type { Config } from '../config.js';`).

- [ ] **Step 3: Verify compilation**

Run: `cd /app/data/home/runhq/server && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/runhq/server
git add src/http/server.ts
git commit -m "feat: sync unsynced widget tickets on server startup"
```

---

## Task 12: Add status sync back (Fly server -> BE on todo status change)

**Files:**
- Modify: `/app/data/home/runhq/server/src/http/server.ts`

- [ ] **Step 1: Add widget status sync event listener**

In `createHttpServer`, after the `syncWidgetTickets` call added in Task 11, add the event listener for status sync back:

```typescript
  // Sync widget todo status changes back to the BE
  if (eventBus && config.cloudApiUrl && config.serverToken) {
    eventBus.on('todo:change', (todo, action, meta) => {
      if (
        action === 'updated' &&
        todo.sourceType === 'widget' &&
        todo.sourceId &&
        meta?.oldStatus &&
        !meta?.fromSync
      ) {
        syncWidgetStatusToBE(config.cloudApiUrl!, config.serverToken!, todo.sourceId, todo.status).catch((err) => {
          console.error('[WidgetSync] Failed to sync status to BE:', err);
        });
      }
    });
  }
```

Then add the helper function (next to `syncWidgetTickets`):

```typescript
/**
 * When a widget-sourced todo's status changes, push the new status back to the BE.
 */
async function syncWidgetStatusToBE(
  cloudApiUrl: string,
  serverToken: string,
  ticketId: string,
  status: string,
) {
  const res = await fetch(`${cloudApiUrl}/api/widget/tickets/${ticketId}/status`, {
    method: 'PATCH',
    headers: {
      'X-Server-Token': serverToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    console.warn(`[WidgetSync] Status sync failed for ticket ${ticketId}: HTTP ${res.status}`);
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /app/data/home/runhq/server && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/runhq/server
git add src/http/server.ts
git commit -m "feat: sync widget todo status changes back to BE"
```

---

## Task 13: Verify end-to-end with type checks

**Files:** All modified files across repos.

- [ ] **Step 1: Type check BE**

Run: `cd /app/data/home/be && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors (or only pre-existing ones).

- [ ] **Step 2: Type check homepage**

Run: `cd /app/data/home/homepage && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 3: Type check Fly server**

Run: `cd /app/data/home/runhq/server && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 4: Type check client**

Run: `cd /app/data/home/runhq/client && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.
