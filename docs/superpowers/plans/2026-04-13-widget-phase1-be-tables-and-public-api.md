# Widget Refactor Phase 1: BE Tables + Public API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add widget database tables and public API to the BE (console.runhq.io) so widget.js can talk directly to the BE instead of the widget server on DigitalOcean.

**Architecture:** Add 5 PostgreSQL tables via Drizzle ORM, a widget auth function, and 7 public API routes to the existing Hono server in HttpServer.ts. Widget.js (static file) served from the BE's public directory. All widget state owned by BE. No separate widget server.

**Tech Stack:** Hono (HTTP), Drizzle ORM (PostgreSQL), jose (JWT), crypto (HMAC-SHA256), Anthropic SDK (title generation)

**Codebase:** `/app/data/home/be`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/db/schema.ts` | Add 5 widget tables (widgetProjects, widgetTickets, widgetUsers, widgetVotes, widgetComments) |
| `src/api/services/WidgetService.ts` | **New.** Widget auth, ticket CRUD, vote logic, title generation |
| `src/api/HttpServer.ts` | Add widget public API routes + management routes |
| `public/widget.js` | **New.** Copy from widget app, update API URL detection |

---

### Task 1: Add widget tables to Drizzle schema

**Files:**
- Modify: `/app/data/home/be/src/db/schema.ts` (append after line 996)

- [ ] **Step 1: Add the 5 widget tables**

Append at the end of `/app/data/home/be/src/db/schema.ts`:

```typescript
// ============================================================================
// Widget — Embeddable voting/feedback widget
// ============================================================================

export const widgetProjects = pgTable('widget_projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: text('server_id').notNull(), // RunHQ server/workspace ID (ws_xxx)
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  apiSecretHash: text('api_secret_hash').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  autoApprove: boolean('auto_approve').default(false).notNull(),
  widgetPosition: text('widget_position'), // e.g. "middle-right", "bottom-left"
  votingPeriodHours: integer('voting_period_hours'),
  channelId: text('channel_id'), // Fly server channel for task creation
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const widgetTickets = pgTable('widget_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => widgetProjects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().$type<'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled'>().default('pending'),
  moderationStatus: text('moderation_status').notNull().$type<'pending' | 'approved' | 'rejected'>().default('pending'),
  isPrivate: boolean('is_private').default(false).notNull(),
  source: text('source').default('widget').notNull(),
  widgetUserId: uuid('widget_user_id').references(() => widgetUsers.id),
  yesVotes: integer('yes_votes').default(0).notNull(),
  noVotes: integer('no_votes').default(0).notNull(),
  votingEndsAt: timestamp('voting_ends_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const widgetUsers = pgTable('widget_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => widgetProjects.id, { onDelete: 'cascade' }),
  externalUserId: text('external_user_id').notNull(),
  name: text('name'),
  username: text('username'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  { name: 'widget_users_project_external_unique', columns: [t.projectId, t.externalUserId], unique: true },
]);

export const widgetVotes = pgTable('widget_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => widgetTickets.id, { onDelete: 'cascade' }),
  widgetUserId: uuid('widget_user_id').notNull().references(() => widgetUsers.id, { onDelete: 'cascade' }),
  value: boolean('value').notNull(), // true = yes, false = no
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  { name: 'widget_votes_ticket_user_unique', columns: [t.ticketId, t.widgetUserId], unique: true },
]);

export const widgetComments = pgTable('widget_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => widgetTickets.id, { onDelete: 'cascade' }),
  widgetUserId: uuid('widget_user_id').notNull().references(() => widgetUsers.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type WidgetProject = typeof widgetProjects.$inferSelect;
export type NewWidgetProject = typeof widgetProjects.$inferInsert;
export type WidgetTicket = typeof widgetTickets.$inferSelect;
export type WidgetUser = typeof widgetUsers.$inferSelect;
export type WidgetVote = typeof widgetVotes.$inferSelect;
export type WidgetComment = typeof widgetComments.$inferSelect;
```

Note: The `integer` import may need to be added to the existing Drizzle imports at the top of schema.ts. Check if `integer` is already imported — if not, add it alongside the existing `uuid`, `text`, `boolean`, `timestamp` imports from `drizzle-orm/pg-core`.

- [ ] **Step 2: Generate and run migration**

```bash
cd /app/data/home/be
npx drizzle-kit generate
npx drizzle-kit migrate
```

Expected: New migration file in `drizzle/` with CREATE TABLE statements for all 5 tables.

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add src/db/schema.ts drizzle/
git commit -m "feat: add widget tables to BE database schema"
```

---

### Task 2: Create WidgetService

**Files:**
- Create: `/app/data/home/be/src/api/services/WidgetService.ts`

- [ ] **Step 1: Create the service file**

Create `/app/data/home/be/src/api/services/WidgetService.ts`:

```typescript
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../../db/index';
import {
  widgetProjects,
  widgetTickets,
  widgetUsers,
  widgetVotes,
  widgetComments,
} from '../../db/schema';
import { eq, and, sql, ne, desc } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WidgetAuthResult {
  projectId: string;
  projectSlug: string;
  widgetUserId?: string;
}

// ---------------------------------------------------------------------------
// Auth — 3 modes: public slug, raw API key, signed JWT
// ---------------------------------------------------------------------------

function base64urlDecode(str: string): Buffer {
  const padded = str
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

export async function authenticateWidget(req: {
  header: (name: string) => string | undefined;
}): Promise<WidgetAuthResult | null> {
  const authHeader = req.header('Authorization');
  const projectHeader = req.header('X-RW-Project');

  // Public mode: project slug
  if (!authHeader && projectHeader) {
    const [project] = await db
      .select({ id: widgetProjects.id, slug: widgetProjects.slug, enabled: widgetProjects.enabled })
      .from(widgetProjects)
      .where(eq(widgetProjects.slug, projectHeader))
      .limit(1);
    if (!project || !project.enabled) return null;
    return { projectId: project.id, projectSlug: project.slug };
  }

  // Bearer token modes
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const dotIndex = token.lastIndexOf('.');

    // Raw API key mode (no dot, e.g. "rw_xxx")
    if (dotIndex === -1) {
      const [project] = await db
        .select({ id: widgetProjects.id, slug: widgetProjects.slug, enabled: widgetProjects.enabled })
        .from(widgetProjects)
        .where(eq(widgetProjects.apiKey, token))
        .limit(1);
      if (!project || !project.enabled) return null;
      return { projectId: project.id, projectSlug: project.slug };
    }

    // Signed JWT mode
    const payloadPart = token.slice(0, dotIndex);
    const signaturePart = token.slice(dotIndex + 1);

    let payload: { sub: string; name?: string; fp: string; iat: number };
    try {
      payload = JSON.parse(base64urlDecode(payloadPart).toString('utf8'));
    } catch {
      return null;
    }
    if (!payload.sub || !payload.fp) return null;

    const [project] = await db
      .select({
        id: widgetProjects.id,
        slug: widgetProjects.slug,
        enabled: widgetProjects.enabled,
        apiSecretHash: widgetProjects.apiSecretHash,
      })
      .from(widgetProjects)
      .where(eq(widgetProjects.apiKey, payload.fp))
      .limit(1);
    if (!project || !project.enabled) return null;

    // Verify HMAC signature
    const expectedHmac = createHmac('sha256', project.apiSecretHash)
      .update(payloadPart)
      .digest('base64url');
    try {
      const expectedBuf = Buffer.from(expectedHmac, 'utf8');
      const actualBuf = Buffer.from(signaturePart, 'utf8');
      if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
        return null;
      }
    } catch {
      return null;
    }

    // Upsert widget user
    const existing = await db
      .select({ id: widgetUsers.id })
      .from(widgetUsers)
      .where(
        and(
          eq(widgetUsers.projectId, project.id),
          eq(widgetUsers.externalUserId, payload.sub),
        ),
      )
      .limit(1);

    let widgetUserId: string;
    if (existing.length) {
      widgetUserId = existing[0].id;
      if (payload.name) {
        await db
          .update(widgetUsers)
          .set({ name: payload.name })
          .where(eq(widgetUsers.id, widgetUserId));
      }
    } else {
      const [inserted] = await db
        .insert(widgetUsers)
        .values({
          projectId: project.id,
          externalUserId: payload.sub,
          name: payload.name ?? null,
        })
        .returning({ id: widgetUsers.id });
      widgetUserId = inserted.id;
    }

    return { projectId: project.id, projectSlug: project.slug, widgetUserId };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Ticket operations
// ---------------------------------------------------------------------------

export async function listTickets(projectId: string, widgetUserId?: string) {
  const tickets = await db
    .select()
    .from(widgetTickets)
    .where(
      and(
        eq(widgetTickets.projectId, projectId),
        ne(widgetTickets.moderationStatus, 'rejected'),
      ),
    )
    .orderBy(desc(widgetTickets.createdAt))
    .limit(50);

  const [project] = await db
    .select({ name: widgetProjects.name, widgetPosition: widgetProjects.widgetPosition })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  // Get user's votes if identified
  let userVoteMap: Record<string, boolean> = {};
  if (widgetUserId && tickets.length > 0) {
    const ticketIds = tickets.map((t) => t.id);
    const votes = await db
      .select({ ticketId: widgetVotes.ticketId, value: widgetVotes.value })
      .from(widgetVotes)
      .where(
        and(
          sql`${widgetVotes.ticketId} IN (${sql.join(ticketIds.map(id => sql`${id}`), sql`, `)})`,
          eq(widgetVotes.widgetUserId, widgetUserId),
        ),
      );
    for (const v of votes) {
      userVoteMap[v.ticketId] = v.value;
    }
  }

  return {
    tickets: tickets.map((t) => ({
      ...t,
      userVote: widgetUserId ? (userVoteMap[t.id] ?? null) : null,
    })),
    projectName: project?.name ?? null,
    position: project?.widgetPosition ?? 'middle-right',
    isIdentified: !!widgetUserId,
  };
}

export async function createTicket(
  projectId: string,
  widgetUserId: string,
  data: { title?: string; description?: string; isPrivate?: boolean },
) {
  const [project] = await db
    .select({
      autoApprove: widgetProjects.autoApprove,
      votingPeriodHours: widgetProjects.votingPeriodHours,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  let title = data.title;
  if (!title && data.description) {
    title = await generateTitle(data.description);
  }
  if (!title) throw new Error('title or description is required');

  const moderationStatus = project?.autoApprove ? 'approved' : 'pending';
  const votingEndsAt =
    project?.votingPeriodHours
      ? new Date(Date.now() + project.votingPeriodHours * 60 * 60 * 1000)
      : null;

  const [ticket] = await db
    .insert(widgetTickets)
    .values({
      projectId,
      title,
      description: data.description ?? null,
      isPrivate: data.isPrivate ?? false,
      widgetUserId,
      moderationStatus,
      votingEndsAt,
      source: 'widget',
    })
    .returning();

  return ticket;
}

export async function listMyTickets(projectId: string, widgetUserId: string) {
  return db
    .select()
    .from(widgetTickets)
    .where(
      and(
        eq(widgetTickets.projectId, projectId),
        eq(widgetTickets.widgetUserId, widgetUserId),
      ),
    )
    .orderBy(desc(widgetTickets.createdAt))
    .limit(50);
}

export async function getTicketStats(projectId: string) {
  const [stats] = await db
    .select({
      totalOpen: sql<number>`count(*) filter (where ${widgetTickets.status} in ('pending', 'planned', 'in_progress', 'needs_review') and ${widgetTickets.moderationStatus} = 'approved')`,
      totalDone: sql<number>`count(*) filter (where ${widgetTickets.status} = 'done' and ${widgetTickets.moderationStatus} = 'approved')`,
    })
    .from(widgetTickets)
    .where(eq(widgetTickets.projectId, projectId));
  return { totalOpen: Number(stats?.totalOpen ?? 0), totalDone: Number(stats?.totalDone ?? 0) };
}

// ---------------------------------------------------------------------------
// Vote operations
// ---------------------------------------------------------------------------

export async function castVote(ticketId: string, widgetUserId: string, value: boolean) {
  // Validate ticket
  const [ticket] = await db
    .select({
      id: widgetTickets.id,
      moderationStatus: widgetTickets.moderationStatus,
      votingEndsAt: widgetTickets.votingEndsAt,
    })
    .from(widgetTickets)
    .where(eq(widgetTickets.id, ticketId))
    .limit(1);

  if (!ticket) throw new Error('Ticket not found');
  if (ticket.moderationStatus !== 'approved') throw new Error('Ticket not approved for voting');
  if (ticket.votingEndsAt && new Date() > ticket.votingEndsAt) throw new Error('Voting period ended');

  // Upsert vote
  const existing = await db
    .select({ id: widgetVotes.id })
    .from(widgetVotes)
    .where(
      and(
        eq(widgetVotes.ticketId, ticketId),
        eq(widgetVotes.widgetUserId, widgetUserId),
      ),
    )
    .limit(1);

  if (existing.length) {
    await db
      .update(widgetVotes)
      .set({ value })
      .where(eq(widgetVotes.id, existing[0].id));
  } else {
    await db.insert(widgetVotes).values({ ticketId, widgetUserId, value });
  }

  await recountVotes(ticketId);
}

export async function retractVote(ticketId: string, widgetUserId: string) {
  await db
    .delete(widgetVotes)
    .where(
      and(
        eq(widgetVotes.ticketId, ticketId),
        eq(widgetVotes.widgetUserId, widgetUserId),
      ),
    );
  await recountVotes(ticketId);
}

async function recountVotes(ticketId: string) {
  const [counts] = await db
    .select({
      yes: sql<number>`count(*) filter (where ${widgetVotes.value} = true)`,
      no: sql<number>`count(*) filter (where ${widgetVotes.value} = false)`,
    })
    .from(widgetVotes)
    .where(eq(widgetVotes.ticketId, ticketId));
  await db
    .update(widgetTickets)
    .set({ yesVotes: Number(counts?.yes ?? 0), noVotes: Number(counts?.no ?? 0) })
    .where(eq(widgetTickets.id, ticketId));
}

// ---------------------------------------------------------------------------
// Project management (for RunHQ UI)
// ---------------------------------------------------------------------------

export async function enableWidget(serverId: string, data: { name: string; channelId?: string }) {
  const apiKey = `rw_${randomBytes(16).toString('hex')}`;
  const apiSecret = randomBytes(32).toString('base64url');
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    + '-' + randomBytes(4).toString('hex');

  const [project] = await db
    .insert(widgetProjects)
    .values({
      serverId,
      name: data.name,
      slug,
      apiKey,
      apiSecretHash: apiSecret,
      channelId: data.channelId ?? null,
    })
    .onConflictDoUpdate({
      target: [widgetProjects.slug],
      set: {
        name: data.name,
        enabled: true,
        apiKey,
        apiSecretHash: apiSecret,
        channelId: data.channelId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return { projectId: project.id, apiKey, apiSecret, slug: project.slug };
}

export async function disableWidget(serverId: string) {
  await db
    .update(widgetProjects)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(widgetProjects.serverId, serverId), eq(widgetProjects.enabled, true)));
}

export async function getWidgetIntegration(serverId: string) {
  const [project] = await db
    .select()
    .from(widgetProjects)
    .where(and(eq(widgetProjects.serverId, serverId), eq(widgetProjects.enabled, true)))
    .limit(1);
  return project ?? null;
}

export async function getWidgetSettings(serverId: string) {
  const project = await getWidgetIntegration(serverId);
  if (!project) return null;
  return {
    auto_approve: project.autoApprove,
    widget_position: project.widgetPosition,
    voting_period_hours: project.votingPeriodHours,
  };
}

export async function updateWidgetSettings(
  serverId: string,
  settings: { auto_approve?: boolean; widget_position?: string; voting_period_hours?: number | null },
) {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (settings.auto_approve !== undefined) updateData.autoApprove = settings.auto_approve;
  if (settings.widget_position !== undefined) updateData.widgetPosition = settings.widget_position;
  if (settings.voting_period_hours !== undefined) updateData.votingPeriodHours = settings.voting_period_hours;

  await db
    .update(widgetProjects)
    .set(updateData)
    .where(and(eq(widgetProjects.serverId, serverId), eq(widgetProjects.enabled, true)));
}

// ---------------------------------------------------------------------------
// Title generation (Claude Haiku)
// ---------------------------------------------------------------------------

async function generateTitle(description: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return description.split('\n')[0].slice(0, 80);
  }
  try {
    const anthropic = new (await import('@anthropic-ai/sdk')).default({ apiKey });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [
        { role: 'user', content: `Generate a concise title (under 80 characters) for this ticket:\n\n${description}` },
      ],
    });
    const block = msg.content[0];
    if (block.type === 'text') return block.text.trim();
    return description.split('\n')[0].slice(0, 80);
  } catch {
    return description.split('\n')[0].slice(0, 80);
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts
git commit -m "feat: add WidgetService with auth, ticket CRUD, vote logic"
```

---

### Task 3: Add widget public API routes to HttpServer.ts

**Files:**
- Modify: `/app/data/home/be/src/api/HttpServer.ts`

- [ ] **Step 1: Add the import**

At the top of `/app/data/home/be/src/api/HttpServer.ts`, add after the existing service imports (around line 26):

```typescript
import * as WidgetService from './services/WidgetService';
```

- [ ] **Step 2: Add widget public API routes**

Add before the `// Mount OAuth routes` line (before line 3685) in HttpServer.ts:

```typescript
  // ==========================================================================
  // Widget Public API (called by widget.js from customer websites)
  // CORS: Hono middleware already sets Access-Control-Allow-Origin: *
  // ==========================================================================

  app.options('/api/widget/*', (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-RW-Project');
    return c.body(null, 204);
  });

  app.get('/api/widget/tickets', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const result = await WidgetService.listTickets(auth.projectId, auth.widgetUserId);
    return c.json(result);
  });

  app.post('/api/widget/tickets', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json();
    try {
      const ticket = await WidgetService.createTicket(auth.projectId, auth.widgetUserId, body);
      return c.json({ ticket }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/api/widget/tickets/mine', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
    const tickets = await WidgetService.listMyTickets(auth.projectId, auth.widgetUserId);
    return c.json({ tickets });
  });

  app.get('/api/widget/tickets/stats', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const stats = await WidgetService.getTicketStats(auth.projectId);
    return c.json(stats);
  });

  app.post('/api/widget/tickets/:id/vote', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
    const { value } = await c.req.json();
    try {
      await WidgetService.castVote(c.req.param('id'), auth.widgetUserId, value);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.delete('/api/widget/tickets/:id/vote', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
    await WidgetService.retractVote(c.req.param('id'), auth.widgetUserId);
    return c.json({ ok: true });
  });

  // ==========================================================================
  // Widget Management API (called by RunHQ frontend UI)
  // ==========================================================================

  app.get('/api/widget/integration', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const serverId = c.req.query('serverId');
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    const integration = await WidgetService.getWidgetIntegration(serverId);
    return c.json({ success: true, data: integration });
  });

  app.post('/api/widget/enable', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const { serverId, name, channelId } = await c.req.json();
    if (!serverId || !name) return c.json({ error: 'serverId and name required' }, 400);
    const result = await WidgetService.enableWidget(serverId, { name, channelId });
    return c.json({ success: true, data: result });
  });

  app.delete('/api/widget/disable', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const serverId = c.req.query('serverId');
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    await WidgetService.disableWidget(serverId);
    return c.json({ success: true });
  });

  app.get('/api/widget/settings', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const serverId = c.req.query('serverId');
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    const settings = await WidgetService.getWidgetSettings(serverId);
    return c.json({ success: true, data: settings });
  });

  app.put('/api/widget/settings', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const { serverId, auto_approve, widget_position, voting_period_hours } = await c.req.json();
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    await WidgetService.updateWidgetSettings(serverId, { auto_approve, widget_position, voting_period_hours });
    return c.json({ success: true });
  });
```

- [ ] **Step 3: Verify build**

```bash
cd /app/data/home/be
npx tsc --noEmit
```

Expected: No errors from widget-related files.

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/be
git add src/api/HttpServer.ts
git commit -m "feat: add widget public + management API routes"
```

---

### Task 4: Copy and adapt widget.js

**Files:**
- Create: `/app/data/home/be/public/widget.js` (copy from `/app/data/home/widget/public/widget.js`)

- [ ] **Step 1: Copy widget.js**

```bash
mkdir -p /app/data/home/be/public
cp /app/data/home/widget/public/widget.js /app/data/home/be/public/widget.js
```

- [ ] **Step 2: Verify the API URL auto-detection works**

The widget.js already derives its API URL from the script src. When served from `console.runhq.io/widget.js`, it will call `console.runhq.io/api/widget/*`. Verify the detection code exists (should be at the top of the file):

```javascript
var RUNHQ_API = (function () {
  try {
    var scripts = document.querySelectorAll('script[src*="widget.js"]');
    var src = scripts[scripts.length - 1].src;
    return src.substring(0, src.lastIndexOf('/'));
  } catch (_) {}
  return "https://www.runhq.io";
})();
```

Update the fallback URL from `https://www.runhq.io` to `https://console.runhq.io`:

```javascript
  return "https://console.runhq.io";
```

- [ ] **Step 3: Configure BE to serve static files**

Check if the BE's Hono app or Next.js already serves from `/public`. If not, add a static file route to HttpServer.ts:

```typescript
// Serve widget.js as static file
app.get('/widget.js', async (c) => {
  const filePath = path.join(process.cwd(), 'public', 'widget.js');
  const content = fs.readFileSync(filePath, 'utf-8');
  c.header('Content-Type', 'application/javascript');
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('Access-Control-Allow-Origin', '*');
  return c.body(content);
});
```

Add this near the top of the routes (after the health check, before auth routes), so it's available without auth.

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/be
git add public/widget.js src/api/HttpServer.ts
git commit -m "feat: serve widget.js from BE as static file"
```

---

### Task 5: Test the full flow end-to-end

- [ ] **Step 1: Start the BE server locally**

```bash
cd /app/data/home/be
npm run dev
```

- [ ] **Step 2: Test widget enable**

```bash
# Get a valid BE auth token first (use existing login)
# Then enable a widget:
curl -s -X POST http://localhost:8080/api/widget/enable \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{"serverId":"test-server","name":"Test Widget"}'
```

Expected: Returns `{ success: true, data: { projectId, apiKey, apiSecret, slug } }`

- [ ] **Step 3: Test ticket listing with API key**

```bash
# Use the apiKey from the enable response
curl -s http://localhost:8080/api/widget/tickets \
  -H "Authorization: Bearer rw_<key-from-above>"
```

Expected: Returns `{ tickets: [], projectName: "Test Widget", position: "middle-right", isIdentified: false }`

- [ ] **Step 4: Test ticket creation with signed token**

```bash
# Generate a signed token using the apiKey and apiSecret from enable
API_KEY="rw_<from-enable>"
API_SECRET="<from-enable>"
PAYLOAD=$(echo -n '{"sub":"user-1","name":"Test User","fp":"'$API_KEY'","iat":'$(date +%s)'}' | base64 | tr '/+' '_-' | tr -d '=')
SIG=$(echo -n $PAYLOAD | openssl dgst -sha256 -hmac "$API_SECRET" -binary | base64 | tr '/+' '_-' | tr -d '=')
TOKEN="$PAYLOAD.$SIG"

curl -s -X POST http://localhost:8080/api/widget/tickets \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Test ticket","description":"This is a test"}'
```

Expected: Returns `{ ticket: { id, title, description, status: "pending", ... } }` with status 201

- [ ] **Step 5: Test widget.js serving**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/widget.js
```

Expected: 200

- [ ] **Step 6: Commit (if any fixes needed)**

```bash
cd /app/data/home/be
git add .
git commit -m "fix: end-to-end test fixes for widget API"
```

---

### Task 6: CORS verification for cross-origin widget.js

- [ ] **Step 1: Test CORS preflight**

```bash
curl -s -X OPTIONS http://localhost:8080/api/widget/tickets \
  -H "Origin: https://customer-app.example.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Authorization" \
  -D -
```

Expected: Response includes:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization, X-RW-Project`
- Status: 204

- [ ] **Step 2: Test CORS on actual request**

```bash
curl -s http://localhost:8080/api/widget/tickets \
  -H "Origin: https://customer-app.example.com" \
  -H "X-RW-Project: <slug-from-enable>" \
  -D - | head -10
```

Expected: Response headers include `Access-Control-Allow-Origin: *`

- [ ] **Step 3: Commit if fixes needed**

```bash
cd /app/data/home/be
git add .
git commit -m "fix: CORS for widget public API"
```
