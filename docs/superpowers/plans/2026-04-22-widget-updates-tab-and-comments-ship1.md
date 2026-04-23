# Widget Updates Tab + Commenting (Ship-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-22-widget-updates-tab-and-comments-design.md`

**Goal:** Ship the widget Updates tab (public changelog of done tickets) and commenting (post/edit/delete with image attachments), with unified storage that keeps widget and RunHQ-app comment threads continuous.

**Architecture:** Backend changes in `/app/data/home/be` only. New widget-scoped HTTP routes under `/api/widget/*` delegate to the existing shared `WorkspaceTaskService` so widget comments land in the same `workspace_task_comments` table as RunHQ-app comments. Widget UI (vanilla JS, single file `public/widget.js`) extends the existing two-tab interface to three tabs, always renders them (disabled state for "My Tickets" when unidentified), and adds a comment composer inside the ticket-detail view with `app-user (id:…)` labeling for externally-authed authors.

**Tech Stack:**
- Backend: TypeScript + Hono + Drizzle ORM + Neon Postgres
- Widget: vanilla JavaScript, single self-contained file
- Tests: vitest (`pnpm vitest run <path>` from `/app/data/home/be`)
- Integration tests use the real Neon dev database with unique `SERVER_ID` per run for isolation

---

## File Map

### Create

- `src/api/services/WidgetService.comments.ts` — extracted or co-located comment-related widget-service functions (optional; may inline into existing `WidgetService.ts` if preferred by conventions)
- `src/api/services/WorkspaceTaskService.updateComment.test.ts` — tests for new `updateComment`
- `src/api/services/WidgetService.updates-tab.test.ts` — tests for `listDoneTickets`
- `src/api/services/WidgetService.comments.test.ts` — tests for comment-related widget service functions
- `src/api/HttpServer.widget-comments.test.ts` — route-level integration tests
- `e2e/widget-updates-and-comments.spec.ts` — Playwright E2E (if Playwright is configured; otherwise document manual QA steps here)

### Modify

- `src/api/services/WorkspaceTaskService.ts` — add `updateComment`
- `src/api/services/WidgetService.ts` — add `listDoneTickets`, `addWidgetComment`, `updateWidgetComment`, `deleteWidgetComment`, `addWidgetCommentAttachment`; extend `getPublicTicketDetail` comment/ticket mapping with `createdByType`, `externalUserId`, `isAuthorOfCurrentUser`, `canEdit`
- `src/api/HttpServer.ts` — add 5 new routes
- `public/widget.js` — three-tab UI, comment composer, edit/delete, `(edited)` marker, `formatAuthorName` helper, `formatRelativeTime` helper

---

## Build Order

Three phases, each independently shippable behind commits. Tasks within a phase should be completed in order (later tasks depend on earlier ones).

- **Phase 1 (Tasks 1–7):** Backend — `WorkspaceTaskService.updateComment`, widget service functions, comment/ticket payload shape extensions, HTTP routes.
- **Phase 2 (Tasks 8–13):** Widget frontend — Updates tab, three-way `activeTab`, always-rendered tabs.
- **Phase 3 (Tasks 14–19):** Widget frontend — comment composer, edit/delete, `(edited)` marker, author labeling, E2E test.

---

# Phase 1 — Backend

### Task 1: `WorkspaceTaskService.updateComment()`

**Files:**
- Modify: `src/api/services/WorkspaceTaskService.ts` (add after the existing `addComment` function, before `deleteComment`)
- Create: `src/api/services/WorkspaceTaskService.updateComment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/services/WorkspaceTaskService.updateComment.test.ts`:

```typescript
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskComments } from '../../db/schema';
import { addComment, updateComment } from './WorkspaceTaskService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_upd_test_${RUN_HEX}`;
const USER_ID = `00000000-0001-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let TASK_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [task] = await db.insert(workspaceTasks).values({ serverId: SERVER_ID, title: 'T' }).returning({ id: workspaceTasks.id });
  if (!task) throw new Error('seed failed');
  TASK_ID = task.id;
});

afterAll(async () => {
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
});

describe('updateComment', () => {
  it('updates content and bumps updatedAt', async () => {
    const created = await addComment(SERVER_ID, TASK_ID, { content: 'original', createdByType: 'external' });
    // wait 20ms so updatedAt is measurably newer
    await new Promise(r => setTimeout(r, 20));
    const updated = await updateComment(SERVER_ID, TASK_ID, created.id, { content: 'edited' });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe('edited');
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it('returns null for unknown commentId', async () => {
    const result = await updateComment(SERVER_ID, TASK_ID, '00000000-0000-0000-0000-000000000000', { content: 'x' });
    expect(result).toBeNull();
  });

  it('returns null for soft-deleted comments', async () => {
    const created = await addComment(SERVER_ID, TASK_ID, { content: 'to-delete', createdByType: 'external' });
    await db.update(workspaceTaskComments).set({ deletedAt: new Date() }).where(eq(workspaceTaskComments.id, created.id));
    const result = await updateComment(SERVER_ID, TASK_ID, created.id, { content: 'x' });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/api/services/WorkspaceTaskService.updateComment.test.ts` (from `/app/data/home/be`)

Expected: FAIL — `updateComment` not exported from `./WorkspaceTaskService`.

- [ ] **Step 3: Implement `updateComment`**

Add to `src/api/services/WorkspaceTaskService.ts`, immediately before the existing `export async function deleteComment(`:

```typescript
export async function updateComment(
  serverId: string,
  taskId: string,
  commentId: string,
  input: { content: string },
): Promise<CanonicalTaskComment | null> {
  const [row] = await db
    .update(workspaceTaskComments)
    .set({ content: input.content, updatedAt: new Date() })
    .where(and(
      eq(workspaceTaskComments.serverId, serverId),
      eq(workspaceTaskComments.taskId, taskId),
      eq(workspaceTaskComments.id, commentId),
      isNull(workspaceTaskComments.deletedAt),
    ))
    .returning();
  if (!row) return null;
  const attachmentGroups = await loadTaskAttachmentGroups([taskId]);
  return toCanonicalComment(row, attachmentGroups.get(taskId)?.byOwnerId.get(row.id) ?? null);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/api/services/WorkspaceTaskService.updateComment.test.ts`

Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WorkspaceTaskService.ts src/api/services/WorkspaceTaskService.updateComment.test.ts
git commit -m "feat(widget): add WorkspaceTaskService.updateComment for edit support

Adds an update-by-id function matching the shape of addComment/deleteComment siblings. Soft-deleted comments cannot be edited. Does not enforce author check (callers enforce)."
```

---

### Task 2: `WidgetService.listDoneTickets()`

**Files:**
- Modify: `src/api/services/WidgetService.ts` (add after the existing `listTickets` function)
- Create: `src/api/services/WidgetService.updates-tab.test.ts`

- [ ] **Step 1: Read the existing `listTickets` to match shape**

Read `src/api/services/WidgetService.ts` lines 360–408 so the new function's envelope shape (`{ projectName, projectSlug, homepageUrl, position, isIdentified, tickets }`) matches exactly.

- [ ] **Step 2: Write the failing test**

Create `src/api/services/WidgetService.updates-tab.test.ts`:

```typescript
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects } from '../../db/schema';
import { listDoneTickets } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_ut_test_${RUN_HEX}`;
const USER_ID = `00000000-0002-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Updates Test ${RUN_HEX}`,
    slug: `updates-test-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`,
    apiSecretHash: `secret-${RUN_HEX}`,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  if (!project) throw new Error('seed failed');
  PROJECT_ID = project.id;

  const now = Date.now();
  await db.insert(workspaceTasks).values([
    { serverId: SERVER_ID, title: 'Done 1 (oldest)',    status: 'done',        visibility: 'public', completedAt: new Date(now - 3000) },
    { serverId: SERVER_ID, title: 'Done 2 (newest)',    status: 'done',        visibility: 'public', completedAt: new Date(now - 1000) },
    { serverId: SERVER_ID, title: 'Done 3 (mid)',       status: 'done',        visibility: 'public', completedAt: new Date(now - 2000) },
    { serverId: SERVER_ID, title: 'Open',               status: 'in_progress', visibility: 'public' },
    { serverId: SERVER_ID, title: 'Cancelled',          status: 'cancelled',   visibility: 'public' },
    { serverId: SERVER_ID, title: 'Private done',       status: 'done',        visibility: 'private', completedAt: new Date(now - 500) },
  ]);
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
});

describe('listDoneTickets', () => {
  it('returns only done + public tickets', async () => {
    const result = await listDoneTickets(PROJECT_ID);
    const titles = result.tickets.map(t => t.title);
    expect(titles).toContain('Done 1 (oldest)');
    expect(titles).toContain('Done 2 (newest)');
    expect(titles).toContain('Done 3 (mid)');
    expect(titles).not.toContain('Open');
    expect(titles).not.toContain('Cancelled');
    expect(titles).not.toContain('Private done');
  });

  it('sorts by completedAt descending', async () => {
    const result = await listDoneTickets(PROJECT_ID);
    const doneTitles = result.tickets.map(t => t.title);
    expect(doneTitles[0]).toBe('Done 2 (newest)');
    expect(doneTitles[1]).toBe('Done 3 (mid)');
    expect(doneTitles[2]).toBe('Done 1 (oldest)');
  });

  it('returns the same envelope shape as listTickets', async () => {
    const result = await listDoneTickets(PROJECT_ID);
    expect(result).toHaveProperty('projectName');
    expect(result).toHaveProperty('projectSlug');
    expect(result).toHaveProperty('homepageUrl');
    expect(result).toHaveProperty('isIdentified');
    expect(result).toHaveProperty('tickets');
    expect(result.isIdentified).toBe(false);
  });

  it('sets isIdentified=true when widgetUserId is provided', async () => {
    const result = await listDoneTickets(PROJECT_ID, 'fake-widget-user-id');
    expect(result.isIdentified).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/api/services/WidgetService.updates-tab.test.ts`

Expected: FAIL — `listDoneTickets` not exported.

- [ ] **Step 4: Implement `listDoneTickets`**

Add to `src/api/services/WidgetService.ts`, immediately after the existing `export async function listTickets(...)` (around line 405):

```typescript
export async function listDoneTickets(projectId: string, widgetUserId?: string) {
  const project = await getWidgetProjectContext(projectId);

  const rows = project
    ? await db
        .select()
        .from(workspaceTasks)
        .where(and(
          buildWidgetVisibleFilter(project),
          eq(workspaceTasks.visibility, 'public'),
          eq(workspaceTasks.status, 'done'),
        ))
        .orderBy(desc(workspaceTasks.completedAt))
        .limit(20)
    : [];

  let userVoteMap: Map<string, boolean> = new Map();
  if (widgetUserId && rows.length > 0) {
    const taskIds = rows.map((t) => t.id);
    const votes = await db
      .select({ taskId: workspaceTaskVotes.taskId, value: workspaceTaskVotes.value })
      .from(workspaceTaskVotes)
      .where(and(
        inArray(workspaceTaskVotes.taskId, taskIds),
        eq(workspaceTaskVotes.voterId, widgetUserId),
      ));
    for (const v of votes) userVoteMap.set(v.taskId, v.value);
  }

  const tickets = rows.map((t) => mapTaskToWidgetResponse(t, userVoteMap.get(t.id) ?? null, true));

  return {
    projectName: project?.name ?? '',
    projectSlug: project?.slug ?? '',
    homepageUrl: getHomepageUrl(),
    position: project?.widgetPosition ?? null,
    isIdentified: !!widgetUserId,
    tickets,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/api/services/WidgetService.updates-tab.test.ts`

Expected: 4 passing tests.

- [ ] **Step 6: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts src/api/services/WidgetService.updates-tab.test.ts
git commit -m "feat(widget): add listDoneTickets service for Updates tab

Mirrors listTickets but filters to status=done and sorts by completedAt desc with limit 20. Same response envelope shape."
```

---

### Task 3: Extend `mapCommentToWidgetResponse` with new fields

**Files:**
- Modify: `src/api/services/WidgetService.ts` (around line 453 where the comments array is mapped inline inside `getPublicTicketDetail`)

We'll extract the inline comment mapping into a named helper and add the four new fields (`createdByType`, `externalUserId`, `isAuthorOfCurrentUser`, `canEdit`). `externalUserId` is resolved by joining `widget_users.externalUserId` via `createdById` when `createdByType === 'external'`.

- [ ] **Step 1: Inspect existing `getPublicTicketDetail` comment mapping**

Read `src/api/services/WidgetService.ts` lines 407–465 to locate the current inline comment mapping. Note: `WorkspaceTaskService.listComments(taskId)` returns `CanonicalTaskComment[]` with `createdByType`, `createdById`, `createdByName` already present.

- [ ] **Step 2: Write the failing test**

Append to `src/api/services/WidgetService.updates-tab.test.ts` (or create a new file `src/api/services/WidgetService.ticket-detail.test.ts` — new file preferred for clarity):

Create `src/api/services/WidgetService.ticket-detail.test.ts`:

```typescript
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskComments, widgetProjects, widgetUsers } from '../../db/schema';
import { getPublicTicketDetail } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_td_test_${RUN_HEX}`;
const USER_ID = `00000000-0003-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let TASK_ID: string;
let WIDGET_USER_ID: string;
const EXTERNAL_USER_ID = `ext-${RUN_HEX}`;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Detail Test ${RUN_HEX}`,
    slug: `detail-test-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`,
    apiSecretHash: `secret-${RUN_HEX}`,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [widgetUser] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID,
    externalUserId: EXTERNAL_USER_ID,
    name: 'Alice',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = widgetUser!.id;

  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'Test task', visibility: 'public', status: 'in_progress',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = task!.id;

  // Seed two comments: one by our widget user (external), one by a RunHQ member
  await db.insert(workspaceTaskComments).values([
    { serverId: SERVER_ID, taskId: TASK_ID, content: 'External comment', createdByType: 'external', createdById: WIDGET_USER_ID, createdByName: 'Alice', updatedAt: new Date() },
    { serverId: SERVER_ID, taskId: TASK_ID, content: 'Member comment',   createdByType: 'member',   createdById: USER_ID,        createdByName: 'RunHQ User', updatedAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
});

describe('getPublicTicketDetail comment payload', () => {
  it('includes createdByType and externalUserId for external comments', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    expect(detail).not.toBeNull();
    const external = detail!.comments.find(c => c.body === 'External comment')!;
    expect(external.createdByType).toBe('external');
    expect(external.externalUserId).toBe(EXTERNAL_USER_ID);
  });

  it('leaves externalUserId null for member comments', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    const member = detail!.comments.find(c => c.body === 'Member comment')!;
    expect(member.createdByType).toBe('member');
    expect(member.externalUserId).toBeNull();
  });

  it('sets isAuthorOfCurrentUser=true for the current widget user\'s external comment', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    const own = detail!.comments.find(c => c.body === 'External comment')!;
    expect(own.isAuthorOfCurrentUser).toBe(true);
    expect(own.canEdit).toBe(true);
  });

  it('sets isAuthorOfCurrentUser=false for other users\' comments', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    const theirs = detail!.comments.find(c => c.body === 'Member comment')!;
    expect(theirs.isAuthorOfCurrentUser).toBe(false);
    expect(theirs.canEdit).toBe(false);
  });

  it('sets isAuthorOfCurrentUser=false when widgetUserId is undefined (anonymous)', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID);
    for (const c of detail!.comments) {
      expect(c.isAuthorOfCurrentUser).toBe(false);
      expect(c.canEdit).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/api/services/WidgetService.ticket-detail.test.ts`

Expected: FAIL — fields don't exist on the comment objects.

- [ ] **Step 4: Implement — extract `mapCommentToWidgetResponse` and extend it**

In `src/api/services/WidgetService.ts`, find the inline comment mapping inside `getPublicTicketDetail` (around line 453):

```typescript
comments: comments.map((comment) => ({
  id: comment.id,
  body: comment.content,
  authorName: comment.createdByName ?? null,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  attachments: (comment.attachments ?? []).map(mapAttachmentSummary),
})),
```

Extract into a helper right above `export async function getPublicTicketDetail(...)`:

```typescript
async function resolveExternalUserIds(commentRows: Array<{ createdByType: string; createdById: string | null }>): Promise<Map<string, string>> {
  // Collect widget_user ids for external comments
  const ids = commentRows
    .filter(c => c.createdByType === 'external' && c.createdById)
    .map(c => c.createdById as string);
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: widgetUsers.id, externalUserId: widgetUsers.externalUserId })
    .from(widgetUsers)
    .where(inArray(widgetUsers.id, ids));
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, r.externalUserId);
  return map;
}

function mapCommentToWidgetResponse(
  comment: CanonicalTaskComment,
  externalUserIdMap: Map<string, string>,
  currentWidgetUserId?: string,
) {
  const externalUserId = comment.createdByType === 'external' && comment.createdById
    ? externalUserIdMap.get(comment.createdById) ?? null
    : null;
  const isAuthorOfCurrentUser = !!currentWidgetUserId
    && comment.createdByType === 'external'
    && comment.createdById === currentWidgetUserId;
  return {
    id: comment.id,
    body: comment.content,
    authorName: comment.createdByName ?? null,
    createdByType: comment.createdByType,
    externalUserId,
    isAuthorOfCurrentUser,
    canEdit: isAuthorOfCurrentUser,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    attachments: (comment.attachments ?? []).map(mapAttachmentSummary),
  };
}
```

Add a matching TypeScript import if missing: `import type { CanonicalTaskComment } from '@runhq/server-protocol';` (check existing imports first — it's likely already imported for other functions).

Replace the inline mapping inside `getPublicTicketDetail` with:

```typescript
const externalUserIdMap = await resolveExternalUserIds(comments);
const mappedComments = comments.map(c => mapCommentToWidgetResponse(c, externalUserIdMap, widgetUserId));

// ... when building the final response object:
comments: mappedComments,
```

Make sure the type `PublicTicketDetail` (declared near top of file) includes the new comment fields. If the type was inlined, update the `comments` array element type to include `createdByType`, `externalUserId`, `isAuthorOfCurrentUser`, `canEdit`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/api/services/WidgetService.ticket-detail.test.ts`

Expected: 5 passing tests.

- [ ] **Step 6: Also add ticket-level `createdByType` and `externalUserId`**

In `mapTaskToWidgetResponse` (the helper used by `listTickets`, `listDoneTickets`, `listMyTickets`, and `getPublicTicketDetail`), add to the returned object:

```typescript
createdByType: row.createdByType,        // 'external' | 'member' etc.
externalUserId: null,                    // populated by caller when available
```

In the callers that have the widget-user map, set `externalUserId` from it. This requires a second look at `listTickets` — the callers that build the ticket list need to resolve `widget_users.externalUserId` for tickets where `createdByType === 'external'` using the same `resolveExternalUserIds`-style helper. For expediency, extend `resolveExternalUserIds` to also accept an array of rows with the same shape and refactor tasks to use a shared helper.

Simplest concrete change: add `createdByType` to the returned `WidgetTicketResponse` type, and set `externalUserId: null` in `mapTaskToWidgetResponse`, then patch callers to compute it.

For this release, scope the ticket-level `externalUserId` to the `getPublicTicketDetail` response only (since only the detail view renders the author name with the `app-user (id:…)` format). List views show `by <authorName>` via `createdByName` which is already present — no backend change needed there if the widget's `formatAuthorName` helper falls back gracefully.

**Decision:** only populate `externalUserId` on the ticket in `getPublicTicketDetail`. List views leave `externalUserId: null`, and the widget's `formatAuthorName` falls back to `authorName` when `externalUserId` is missing.

Update the test section of `WidgetService.ticket-detail.test.ts` with one more test:

```typescript
it('exposes createdByType and externalUserId on the ticket itself when available', async () => {
  // Setup: create a ticket authored by our widget user
  const [extTask] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'Widget-authored', visibility: 'public',
    createdByType: 'external', createdById: WIDGET_USER_ID, createdByName: 'Alice',
  }).returning({ id: workspaceTasks.id });
  const detail = await getPublicTicketDetail(PROJECT_ID, extTask!.id, WIDGET_USER_ID);
  expect(detail!.ticket.createdByType).toBe('external');
  expect(detail!.ticket.externalUserId).toBe(EXTERNAL_USER_ID);
  // cleanup
  await db.delete(workspaceTasks).where(eq(workspaceTasks.id, extTask!.id));
});
```

- [ ] **Step 7: Run all detail tests**

Run: `pnpm vitest run src/api/services/WidgetService.ticket-detail.test.ts`

Expected: 6 passing tests.

- [ ] **Step 8: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts src/api/services/WidgetService.ticket-detail.test.ts
git commit -m "feat(widget): expose createdByType, externalUserId, isAuthorOfCurrentUser on comments

Enables the widget to render edit/delete affordances for own comments and to format externally-authed authors as 'app-user (id:…)'. Ticket detail response also carries externalUserId so the detail view can label the ticket author."
```

---

### Task 4: `WidgetService.addWidgetComment()`

**Files:**
- Modify: `src/api/services/WidgetService.ts`
- Create: `src/api/services/WidgetService.comments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/services/WidgetService.comments.test.ts`:

```typescript
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskComments, widgetProjects, widgetUsers } from '../../db/schema';
import { addWidgetComment } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_cmt_test_${RUN_HEX}`;
const USER_ID = `00000000-0004-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let TASK_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `Cmt Test ${RUN_HEX}`, slug: `cmt-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`, apiSecretHash: `secret-${RUN_HEX}`, enabled: true, isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-${RUN_HEX}`, name: 'Author',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
  const [t] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'T', visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = t!.id;
});

afterAll(async () => {
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
});

describe('addWidgetComment', () => {
  it('creates a comment with createdByType=external and createdById=widgetUserId', async () => {
    const result = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'Hello from widget');
    expect(result.body).toBe('Hello from widget');
    expect(result.createdByType).toBe('external');
    expect(result.isAuthorOfCurrentUser).toBe(true);
    // DB row check
    const [row] = await db.select().from(workspaceTaskComments).where(eq(workspaceTaskComments.id, result.id));
    expect(row.createdById).toBe(WIDGET_USER_ID);
    expect(row.createdByType).toBe('external');
  });

  it('throws Ticket not found when ticket does not exist in this project', async () => {
    await expect(
      addWidgetComment(PROJECT_ID, '00000000-0000-0000-0000-000000000000', WIDGET_USER_ID, 'x')
    ).rejects.toThrow('Ticket not found');
  });

  it('throws Ticket not found when ticket is private', async () => {
    const [priv] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'Priv', visibility: 'private',
    }).returning({ id: workspaceTasks.id });
    await expect(
      addWidgetComment(PROJECT_ID, priv!.id, WIDGET_USER_ID, 'x')
    ).rejects.toThrow('Ticket not found');
  });

  it('uses the widget user name from widget_users.name as createdByName', async () => {
    const result = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'second');
    expect(result.authorName).toBe('Author');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/api/services/WidgetService.comments.test.ts`

Expected: FAIL — `addWidgetComment` not exported.

- [ ] **Step 3: Implement**

Add to `src/api/services/WidgetService.ts` (after `getPublicTicketDetail`):

```typescript
async function resolveTicketVisibleToWidget(projectId: string, ticketId: string): Promise<{ serverId: string } | null> {
  const project = await getWidgetProjectContext(projectId);
  if (!project) return null;
  const [task] = await db
    .select({ id: workspaceTasks.id, serverId: workspaceTasks.serverId })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      buildWidgetVisibleFilter(project),
      eq(workspaceTasks.visibility, 'public'),
    ))
    .limit(1);
  return task ? { serverId: task.serverId } : null;
}

export async function addWidgetComment(
  projectId: string,
  ticketId: string,
  widgetUserId: string,
  content: string,
) {
  const visible = await resolveTicketVisibleToWidget(projectId, ticketId);
  if (!visible) throw new Error('Ticket not found');

  // Resolve widget user display name
  const [widgetUser] = await db
    .select({ name: widgetUsers.name })
    .from(widgetUsers)
    .where(eq(widgetUsers.id, widgetUserId))
    .limit(1);

  const comment = await WorkspaceTaskService.addComment(visible.serverId, ticketId, {
    content,
    createdByType: 'external',
    createdById: widgetUserId,
    createdByName: widgetUser?.name ?? null,
  });

  // Build the externalUserId map so response matches mapCommentToWidgetResponse shape
  const externalUserIdMap = await resolveExternalUserIds([comment]);
  return mapCommentToWidgetResponse(comment, externalUserIdMap, widgetUserId);
}
```

Add `import * as WorkspaceTaskService from './WorkspaceTaskService';` at the top of the file if it's not already imported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/api/services/WidgetService.comments.test.ts`

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts src/api/services/WidgetService.comments.test.ts
git commit -m "feat(widget): add addWidgetComment service

Creates a comment via shared WorkspaceTaskService.addComment with createdByType=external. Performs visibility check (ticket must be in project and public) before write."
```

---

### Task 5: `updateWidgetComment` and `deleteWidgetComment`

**Files:**
- Modify: `src/api/services/WidgetService.ts`
- Modify: `src/api/services/WidgetService.comments.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/api/services/WidgetService.comments.test.ts`:

```typescript
import { updateWidgetComment, deleteWidgetComment } from './WidgetService';
// (move this import to the top of the file with the others)

describe('updateWidgetComment', () => {
  it('updates content when widgetUserId matches the author', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'original');
    await new Promise(r => setTimeout(r, 20));
    const updated = await updateWidgetComment(PROJECT_ID, TASK_ID, created.id, WIDGET_USER_ID, 'edited');
    expect(updated.body).toBe('edited');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it('throws Not the comment author when widgetUserId is different', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'x');
    const [otherUser] = await db.insert(widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-other-${RUN_HEX}`, name: 'Other',
    }).returning({ id: widgetUsers.id });
    await expect(
      updateWidgetComment(PROJECT_ID, TASK_ID, created.id, otherUser!.id, 'hacked')
    ).rejects.toThrow('Not the comment author');
  });

  it('throws Not the comment author when comment is by a member (not external)', async () => {
    // Seed a member-authored comment
    const [memberComment] = await db.insert(workspaceTaskComments).values({
      serverId: SERVER_ID, taskId: TASK_ID, content: 'member',
      createdByType: 'member', createdById: USER_ID, createdByName: 'M', updatedAt: new Date(),
    }).returning({ id: workspaceTaskComments.id });
    // Even if widgetUserId happens to equal USER_ID (collision), widget users can't edit member comments
    await expect(
      updateWidgetComment(PROJECT_ID, TASK_ID, memberComment!.id, USER_ID, 'spoof')
    ).rejects.toThrow('Not the comment author');
  });

  it('throws Comment not found for unknown id', async () => {
    await expect(
      updateWidgetComment(PROJECT_ID, TASK_ID, '00000000-0000-0000-0000-000000000000', WIDGET_USER_ID, 'x')
    ).rejects.toThrow('Comment not found');
  });
});

describe('deleteWidgetComment', () => {
  it('soft-deletes when widgetUserId matches the author', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'to-delete');
    await deleteWidgetComment(PROJECT_ID, TASK_ID, created.id, WIDGET_USER_ID);
    const [row] = await db.select().from(workspaceTaskComments).where(eq(workspaceTaskComments.id, created.id));
    expect(row.deletedAt).not.toBeNull();
  });

  it('throws Not the comment author when widgetUserId is different', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'mine');
    const [other] = await db.insert(widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-o2-${RUN_HEX}`, name: 'O',
    }).returning({ id: widgetUsers.id });
    await expect(
      deleteWidgetComment(PROJECT_ID, TASK_ID, created.id, other!.id)
    ).rejects.toThrow('Not the comment author');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/api/services/WidgetService.comments.test.ts`

Expected: FAIL — `updateWidgetComment` / `deleteWidgetComment` not exported.

- [ ] **Step 3: Implement**

Add to `src/api/services/WidgetService.ts`:

```typescript
async function loadAndAuthorizeWidgetComment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
): Promise<{ serverId: string }> {
  const visible = await resolveTicketVisibleToWidget(projectId, ticketId);
  if (!visible) throw new Error('Ticket not found');
  const [row] = await db
    .select({
      id: workspaceTaskComments.id,
      createdByType: workspaceTaskComments.createdByType,
      createdById: workspaceTaskComments.createdById,
      deletedAt: workspaceTaskComments.deletedAt,
    })
    .from(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.id, commentId),
      eq(workspaceTaskComments.taskId, ticketId),
    ))
    .limit(1);
  if (!row || row.deletedAt) throw new Error('Comment not found');
  if (row.createdByType !== 'external' || row.createdById !== widgetUserId) {
    throw new Error('Not the comment author');
  }
  return { serverId: visible.serverId };
}

export async function updateWidgetComment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
  content: string,
) {
  const { serverId } = await loadAndAuthorizeWidgetComment(projectId, ticketId, commentId, widgetUserId);
  const updated = await WorkspaceTaskService.updateComment(serverId, ticketId, commentId, { content });
  if (!updated) throw new Error('Comment not found');
  const externalUserIdMap = await resolveExternalUserIds([updated]);
  return mapCommentToWidgetResponse(updated, externalUserIdMap, widgetUserId);
}

export async function deleteWidgetComment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
) {
  const { serverId } = await loadAndAuthorizeWidgetComment(projectId, ticketId, commentId, widgetUserId);
  await WorkspaceTaskService.deleteComment(serverId, ticketId, commentId);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/api/services/WidgetService.comments.test.ts`

Expected: all tests from Task 4 + 6 new tests pass (10 total).

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts src/api/services/WidgetService.comments.test.ts
git commit -m "feat(widget): add updateWidgetComment and deleteWidgetComment

Author-only authorization enforced via createdByType='external' AND createdById=widgetUserId. Member-authored comments cannot be modified via widget even on ID collision."
```

---

### Task 6: `addWidgetCommentAttachment`

**Files:**
- Modify: `src/api/services/WidgetService.ts`
- Modify: `src/api/services/WidgetService.comments.test.ts`

This reuses the same `TaskAttachmentStorageService` used by `addTicketAttachment`. Locate the existing ticket-attachment function (around the `POST /api/widget/tickets/:id/attachments` handler helper) and mirror it with `ownerType: 'comment'` and `ownerId: commentId`.

The existing `uploadTicketAttachment` at `src/api/services/WidgetService.ts:688` is our template. It: (1) validates via `ALLOWED_IMAGE_TYPES` + `MAX_ATTACHMENT_SIZE`, (2) checks per-ticket count against `MAX_ATTACHMENTS_PER_TICKET`, (3) uploads to R2 via `attachmentStorage.storeUpload(...)`, (4) inserts into `workspaceTaskAttachments` with `ownerType: 'task'`, ownerId=ticketId, (5) generates a signed download URL. Our comment version uses `ownerType: 'comment'` and ownerId=commentId, with a per-comment count limit (5).

- [ ] **Step 1: Write the test** (append to `WidgetService.comments.test.ts`)

```typescript
import { addWidgetCommentAttachment } from './WidgetService';

describe('addWidgetCommentAttachment', () => {
  it('rejects when attachment storage is not configured in test env (expected default)', async () => {
    // This test documents behavior — if storage isn't configured in the test env,
    // uploads throw a predictable error. The 401/403 auth paths are covered by
    // HTTP integration tests; here we just verify the author-only gate runs BEFORE
    // any storage call.
    const comment = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'with attachment');
    const [other] = await db.insert(widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-a-${RUN_HEX}`, name: 'O',
    }).returning({ id: widgetUsers.id });
    await expect(
      addWidgetCommentAttachment(PROJECT_ID, TASK_ID, comment.id, other!.id, {
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mimeType: 'image/png',
        filename: 'test.png',
      })
    ).rejects.toThrow('Not the comment author');
  });

  it('rejects invalid mime types for the author', async () => {
    const comment = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'wrong type');
    await expect(
      addWidgetCommentAttachment(PROJECT_ID, TASK_ID, comment.id, WIDGET_USER_ID, {
        buffer: Buffer.from([0]),
        mimeType: 'application/x-shellscript',
        filename: 'evil.sh',
      })
    ).rejects.toThrow(/image files are allowed/);
  });
});
```

(Full happy-path upload is covered by manual QA in Task 16's Step 4 — hitting a real R2 bucket inside unit tests is out of scope. If a unit-level happy path is wanted later, mock `attachmentStorage.storeUpload` and `attachmentStorage.createDownloadUrl` globally.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/api/services/WidgetService.comments.test.ts`

Expected: FAIL — `addWidgetCommentAttachment` not exported.

- [ ] **Step 3: Implement**

Add to `src/api/services/WidgetService.ts` (after `uploadTicketAttachment`):

```typescript
const MAX_ATTACHMENTS_PER_COMMENT = 5;

export async function addWidgetCommentAttachment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
  file: { buffer: Buffer; mimeType: string; filename: string; originalName?: string },
) {
  const { serverId } = await loadAndAuthorizeWidgetComment(projectId, ticketId, commentId, widgetUserId);

  if (!attachmentStorage.isConfigured()) {
    throw new Error('Attachment storage is not configured');
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimeType)) {
    throw new Error('Only image files are allowed (JPEG, PNG, GIF, WebP, SVG)');
  }
  if (file.buffer.length > MAX_ATTACHMENT_SIZE) {
    throw new Error('File size exceeds 5MB limit');
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.ownerType, 'comment'),
      eq(workspaceTaskAttachments.ownerId, commentId),
    ));
  if (Number(countRow.count) >= MAX_ATTACHMENTS_PER_COMMENT) {
    throw new Error(`Maximum ${MAX_ATTACHMENTS_PER_COMMENT} attachments per comment`);
  }

  const stored = await attachmentStorage.storeUpload({
    serverId,
    body: file.buffer,
    mimeType: file.mimeType,
    filename: file.filename,
    originalName: file.originalName ?? file.filename,
    ownerType: 'comment',
  });

  const [attachment] = await db
    .insert(workspaceTaskAttachments)
    .values({
      serverId,
      taskId: ticketId,
      ownerType: 'comment',
      ownerId: commentId,
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
      mimeType: stored.mimeType,
      originalName: stored.originalName ?? null,
    })
    .returning();

  const url = await attachmentStorage.createDownloadUrl({
    storageProvider: stored.storageProvider,
    storageKey: stored.storageKey,
    originalName: stored.originalName,
  });

  return {
    id: attachment.id,
    filename: stored.storageKey.split('/').pop(),
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    url,
  };
}
```

Note the signature: `{ buffer, mimeType, filename, originalName? }` — not a raw `File`. The HTTP route (Task 7) adapts the multipart-form `File` into this shape exactly the way `POST /api/widget/tickets/:id/attachments` does.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/api/services/WidgetService.comments.test.ts`

Expected: all previous tests still pass + 2 new ones.

- [ ] **Step 6: Commit**

```bash
cd /app/data/home/be
git add src/api/services/WidgetService.ts src/api/services/WidgetService.comments.test.ts
git commit -m "feat(widget): add addWidgetCommentAttachment

Mirrors addTicketAttachment but with ownerType='comment'. Author-only authorization."
```

---

### Task 7: HTTP routes for Updates + comments

**Files:**
- Modify: `src/api/HttpServer.ts` (append five routes after the existing ticket-attachment DELETE handler, around line 4780)
- Create: `src/api/HttpServer.widget-comments.test.ts`

- [ ] **Step 1: Write HTTP tests**

Create `src/api/HttpServer.widget-comments.test.ts`. Follow the existing pattern from `HttpServer.widget-cache-invalidate.test.ts` — mock service layer, test the HTTP surface:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./oauth/index', () => ({ default: new (require('hono').Hono)() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({ checkCloudOpPermission: vi.fn(), getServer: vi.fn(), fetchFromServer: vi.fn() }));

vi.mock('./services/WidgetService', () => ({
  authenticateWidget: vi.fn(),
  listDoneTickets: vi.fn(),
  addWidgetComment: vi.fn(),
  updateWidgetComment: vi.fn(),
  deleteWidgetComment: vi.fn(),
  addWidgetCommentAttachment: vi.fn(),
  enableWidget: vi.fn(), disableWidget: vi.fn(), updateWidgetSettings: vi.fn(),
  WidgetSettingsValidationError: class extends Error {},
}));

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } }
}));

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';

const makeApp = () => createHttpApp();

describe('GET /api/widget/tickets/updates', () => {
  beforeEach(() => vi.resetAllMocks());

  it('401 when not authenticated', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/updates');
    expect(res.status).toBe(401);
  });

  it('200 with result from listDoneTickets', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: false });
    (WidgetService.listDoneTickets as any).mockResolvedValue({ tickets: [{ id: 't1' }] });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/updates');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickets[0].id).toBe('t1');
  });
});

describe('POST /api/widget/tickets/:id/comments', () => {
  beforeEach(() => vi.resetAllMocks());

  it('401 without signed token', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: false });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('201 on success', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.addWidgetComment as any).mockResolvedValue({ id: 'c1', body: 'hi' });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.comment.id).toBe('c1');
  });

  it('404 when Ticket not found', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.addWidgetComment as any).mockRejectedValue(new Error('Ticket not found'));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/widget/tickets/:id/comments/:commentId', () => {
  beforeEach(() => vi.resetAllMocks());

  it('403 when Not the comment author', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.updateWidgetComment as any).mockRejectedValue(new Error('Not the comment author'));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('200 on success with updated comment', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.updateWidgetComment as any).mockResolvedValue({ id: 'c1', body: 'edited' });
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'edited' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/widget/tickets/:id/comments/:commentId', () => {
  beforeEach(() => vi.resetAllMocks());

  it('403 when Not the comment author', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.deleteWidgetComment as any).mockRejectedValue(new Error('Not the comment author'));
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('200 on success', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({ projectId: 'p', authenticated: true, widgetUserId: 'u' });
    (WidgetService.deleteWidgetComment as any).mockResolvedValue(undefined);
    const app = makeApp();
    const res = await app.request('/api/widget/tickets/t1/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/api/HttpServer.widget-comments.test.ts`

Expected: FAIL — routes don't exist.

- [ ] **Step 3: Add routes**

In `src/api/HttpServer.ts`, find the end of the existing widget routes block (the `DELETE /api/widget/tickets/:id/attachments/:attachmentId` handler, around line 4780). Immediately after it, append the five new routes:

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
    if (!file || typeof (file as any).arrayBuffer !== 'function') {
      return c.json({ error: 'file field is required' }, 400);
    }
    const inputFile = file as globalThis.File;
    const buffer = Buffer.from(await inputFile.arrayBuffer());
    const attachment = await WidgetService.addWidgetCommentAttachment(
      auth.projectId, c.req.param('id'), c.req.param('commentId'), auth.widgetUserId,
      { buffer, mimeType: inputFile.type || 'application/octet-stream', filename: inputFile.name || 'attachment', originalName: inputFile.name },
    );
    return c.json({ attachment }, 201);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg === 'Comment not found' || msg === 'Ticket not found') return c.json({ error: msg }, 404);
    if (msg === 'Not the comment author') return c.json({ error: msg }, 403);
    return c.json({ error: msg }, 400);
  }
});
```

- [ ] **Step 4: Run HTTP tests**

Run: `pnpm vitest run src/api/HttpServer.widget-comments.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Run the full backend typecheck**

Run: `pnpm typecheck` (from `/app/data/home/be`)

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd /app/data/home/be
git add src/api/HttpServer.ts src/api/HttpServer.widget-comments.test.ts
git commit -m "feat(widget): add HTTP routes for Updates tab and comments

- GET  /api/widget/tickets/updates
- POST /api/widget/tickets/:id/comments
- PATCH /api/widget/tickets/:id/comments/:commentId
- DELETE /api/widget/tickets/:id/comments/:commentId
- POST /api/widget/tickets/:id/comments/:commentId/attachments

All delegate to WidgetService; error-code mapping: 401 on unauth, 403 on non-author, 404 on missing resource, 400 otherwise."
```

---

# Phase 2 — Widget Frontend: Updates Tab

### Task 8: Add API stubs and updatesCache

**Files:**
- Modify: `public/widget.js` (around line 107–170, next to `loadTickets`)

- [ ] **Step 1: Add the cache variable and API functions**

In `public/widget.js`, find the block around line 107 containing `function loadTickets()` and the other API stubs. Immediately after them, add:

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
  }).then(function (r) { return r.json(); });
}
```

Find the existing cache declarations (around line 26–30 where `ticketsCache`, `mySubmissionsCountCache` are declared) and add:

```javascript
var updatesCache = null;
```

- [ ] **Step 2: Verify no syntax errors**

Rebuild the backend dev server (it serves widget.js):

```bash
cd /app/data/home/be
pnpm dev
```

(Leave running in background; not required to re-run — this is just to catch syntax errors if any.)

Open the widget in a browser (on the embedding app or preview URL) and confirm the widget still loads and works identically to before (the new functions are not yet wired up).

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): add API stubs for Updates + comments and updatesCache

No behavior change — stubs are defined but not yet called by any render path."
```

---

### Task 9: Expand `activeTab` to three-way enum and add `handleTabChange`

**Files:**
- Modify: `public/widget.js` (around line 26 where `activeTab` is declared)

- [ ] **Step 1: Change the default**

Find `var activeTab = "all";` (around line 26). Replace with:

```javascript
var activeTab = "updates"; // "updates" | "all" | "mine"
```

- [ ] **Step 2: Add `handleTabChange`**

Search for the three places `activeTab = tab;` is assigned inside inlined callbacks (inside `renderCurrentTab` around line 1635 and `showMySubmissionsView` around line 1673). We'll replace those inlined callbacks with a single shared function in the next task. For now, add the shared function at module scope, right below the other render helpers (near line 1280 where the "Duration, stats, tabs" comment block begins):

```javascript
function handleTabChange(tab) {
  activeTab = tab;
  var isIdentified = !!config.isIdentified;
  if (tab === "updates") showUpdatesView(isIdentified);
  else if (tab === "mine") showMySubmissionsView(isIdentified);
  else renderCurrentTab(isIdentified);
}
```

(Note: `showUpdatesView` doesn't exist yet — it's added in Task 11. This will reference an undefined function; that's OK because `handleTabChange` isn't called anywhere yet — the next tasks wire it up.)

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): expand activeTab enum and extract handleTabChange

activeTab becomes 'updates' | 'all' | 'mine' with 'updates' as default. handleTabChange is module-scoped and will replace the three inlined callbacks in the next commits."
```

---

### Task 10: Update `renderTabs` to three-button layout with disabled state

**Files:**
- Modify: `public/widget.js` (lines 1302–1316)

- [ ] **Step 1: Replace `renderTabs`**

Find the existing function (lines 1302–1316):

```javascript
function renderTabs(onTabChange, myCount) {
  var allBtn = h("button", {
    className: "rw-tab-btn" + (activeTab === "all" ? " rw-tab-active" : ""),
    onClick: function () { onTabChange("all"); },
  }, "Recent Tickets");
  var mineChildren = [h("span", null, "My Tickets")];
  if (myCount != null && myCount > 0) {
    mineChildren.push(h("span", { className: "rw-tab-badge" }, String(myCount)));
  }
  var mineBtn = h("button", {
    className: "rw-tab-btn" + (activeTab === "mine" ? " rw-tab-active" : ""),
    onClick: function () { onTabChange("mine"); },
  }, mineChildren);
  return h("div", { className: "rw-tabs" }, [allBtn, mineBtn]);
}
```

Replace with:

```javascript
function renderTabs(onTabChange, myCount, isIdentified) {
  var updatesBtn = h("button", {
    className: "rw-tab-btn" + (activeTab === "updates" ? " rw-tab-active" : ""),
    onClick: function () { onTabChange("updates"); },
  }, "Updates");
  var allBtn = h("button", {
    className: "rw-tab-btn" + (activeTab === "all" ? " rw-tab-active" : ""),
    onClick: function () { onTabChange("all"); },
  }, "Recent Tickets");
  var mineChildren = [h("span", null, "My Tickets")];
  if (myCount != null && myCount > 0) {
    mineChildren.push(h("span", { className: "rw-tab-badge" }, String(myCount)));
  }
  var mineBtnAttrs = {
    className: "rw-tab-btn" + (activeTab === "mine" ? " rw-tab-active" : ""),
    onClick: function () { if (isIdentified) onTabChange("mine"); },
  };
  if (!isIdentified) {
    mineBtnAttrs.disabled = true;
    mineBtnAttrs.title = "Log in to view your tickets";
  }
  var mineBtn = h("button", mineBtnAttrs, mineChildren);
  return h("div", { className: "rw-tabs" }, [updatesBtn, allBtn, mineBtn]);
}
```

- [ ] **Step 2: Add disabled-state CSS**

Find the CSS block around line 656–704 (where `.rw-tab-btn`, `.rw-tab-active`, `.rw-tab-badge` are defined). Immediately after `.rw-tab-badge`, append (inside the styleRules string concatenation):

```javascript
".rw-tab-btn:disabled{opacity:.5;cursor:not-allowed}" +
```

(Match the exact concatenation pattern used in the surrounding code — each rule is its own string literal joined with `+`.)

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): renderTabs supports three tabs with disabled 'My Tickets' when unidentified"
```

---

### Task 11: Add `formatRelativeTime` helper and `showUpdatesView`

**Files:**
- Modify: `public/widget.js`

- [ ] **Step 1: Add `formatRelativeTime`**

Near the existing `formatDuration` function (around line 1284), add:

```javascript
function formatRelativeTime(isoOrMs) {
  if (!isoOrMs) return "";
  var t = typeof isoOrMs === "string" ? Date.parse(isoOrMs) : isoOrMs;
  if (isNaN(t)) return "";
  var diff = Date.now() - t;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  if (diff < 86400000 * 30) return Math.floor(diff / 86400000) + "d ago";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
```

- [ ] **Step 2: Add `renderUpdatesList`**

Add immediately before `renderMySubmissions` (around line 1319):

```javascript
function renderUpdatesList(tickets) {
  if (!tickets || tickets.length === 0) {
    return renderEmpty("Nothing shipped yet.");
  }
  var container = h("div", null);
  tickets.forEach(function (p) {
    var desc = (p.description || "").length > 140
      ? p.description.slice(0, 140) + "…"
      : (p.description || "");
    var badge = h("span", {
      className: "rw-status-badge",
      style: "color:#10b981;background:#10b9811a",
    }, "Done");
    var relTime = p.completedAt ? "Shipped " + formatRelativeTime(p.completedAt) : "";
    var metaItems = [badge];
    if (relTime) metaItems.push(h("span", { className: "rw-submission-date" }, relTime));
    var cardChildren = [h("div", { className: "rw-submission-title" }, p.title)];
    if (desc) cardChildren.push(h("div", { className: "rw-submission-desc" }, desc));
    cardChildren.push(h("div", { className: "rw-submission-meta" }, metaItems));
    var card = h("div", {
      className: "rw-submission-card",
      onClick: (function (ticketId) {
        return function () { showTicketDetail(ticketId); };
      })(p.id),
    }, cardChildren);
    container.appendChild(card);
  });
  return container;
}
```

- [ ] **Step 3: Add `showUpdatesView` and `renderUpdatesView`**

Add immediately before `renderCurrentTab` (around line 1618):

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

  if (isIdentified) {
    container.appendChild(renderInlineForm(submitSuggestion));
  } else {
    container.appendChild(renderLoginPrompt());
  }
  container.appendChild(h("hr", { className: "rw-divider" }));
  container.appendChild(renderTabs(handleTabChange, mySubmissionsCountCache, isIdentified));
  container.appendChild(renderUpdatesList(updatesCache));
  setBodyContent(container);
}
```

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): add Updates tab view (list + renderer + loader)

Updates tab renders done tickets sorted by completedAt desc, with relative 'Shipped Xd ago' timestamps. Empty state: 'Nothing shipped yet.'"
```

---

### Task 12: Wire Updates into `renderCurrentTab`, `showMySubmissionsView`, and `openPanel`

**Files:**
- Modify: `public/widget.js`

- [ ] **Step 1: Make `renderCurrentTab` render tabs always and use `handleTabChange`**

Find `renderCurrentTab` (around line 1618). Replace its current `if (isIdentified) { container.appendChild(renderTabs(...)) }` block with an unconditional call using `handleTabChange`:

```javascript
function renderCurrentTab(isIdentified) {
  var container = h("div", null);
  var statsBanner = renderStats(statsCache);
  if (statsBanner) container.appendChild(statsBanner);

  if (isIdentified) {
    container.appendChild(renderInlineForm(submitSuggestion));
  } else {
    container.appendChild(renderLoginPrompt());
  }
  container.appendChild(h("hr", { className: "rw-divider" }));

  // Always render tabs; My Tickets is disabled when unidentified
  container.appendChild(renderTabs(handleTabChange, mySubmissionsCountCache, isIdentified));

  if (activeTab === "all") {
    var panelContent = renderTicketList(ticketsCache);
    while (panelContent.firstChild) {
      container.appendChild(panelContent.firstChild);
    }
  }
  setBodyContent(container);
}
```

- [ ] **Step 2: Make `showMySubmissionsView` use `handleTabChange`**

Find `showMySubmissionsView` (around line 1656). Replace its inlined `renderTabs` callback with `handleTabChange`:

```javascript
function showMySubmissionsView(isIdentified) {
  setBodyContent(renderLoading());
  loadMySubmissions().then(function (data) {
    var myTickets = data.tickets || [];
    mySubmissionsCountCache = myTickets.length;

    var wrap = h("div", null);
    var statsBanner = renderStats(statsCache);
    if (statsBanner) wrap.appendChild(statsBanner);

    if (isIdentified) {
      wrap.appendChild(renderInlineForm(submitSuggestion));
    }

    wrap.appendChild(h("hr", { className: "rw-divider" }));
    wrap.appendChild(renderTabs(handleTabChange, mySubmissionsCountCache, isIdentified));
    wrap.appendChild(renderMySubmissions(myTickets));
    setBodyContent(wrap);
  }).catch(function (err) {
    setBodyContent(renderNotice("error", "Could not load submissions: " + err.message));
  });
}
```

- [ ] **Step 3: Make the panel open directly into Updates tab**

Find `showPanelView` (around line 1581). Modify to route based on `activeTab`:

```javascript
function showPanelView() {
  var isIdentified = !!config.isIdentified;

  function loadMyCount() {
    if (isIdentified && mySubmissionsCountCache == null) {
      loadMySubmissions().then(function (mineData) {
        mySubmissionsCountCache = (mineData.tickets || []).length;
        // Re-render the current view so the badge updates
        if (activeTab === "updates") renderUpdatesView(isIdentified);
        else if (activeTab === "all") renderCurrentTab(isIdentified);
      }).catch(function () {});
    }
  }

  // Default landing is the Updates tab
  if (activeTab === "updates") {
    showUpdatesView(isIdentified);
    loadMyCount();
    return;
  }
  if (activeTab === "mine") {
    showMySubmissionsView(isIdentified);
    return;
  }

  // activeTab === 'all'
  if (ticketsCache) {
    headerTitleEl.textContent = "Help us improve " + (config.projectName || config.projectId);
    renderCurrentTab(isIdentified);
    loadMyCount();
    return;
  }
  setBodyContent(renderLoading());
  loadTickets().then(function (data) {
    ticketsCache = data.tickets || [];
    if (data.projectName) {
      config.projectName = data.projectName;
      headerTitleEl.textContent = "Help us improve " + data.projectName;
    }
    renderCurrentTab(isIdentified);
    loadMyCount();
  }).catch(function (err) {
    setBodyContent(renderNotice("error", "Could not load proposals: " + err.message));
  });
}
```

- [ ] **Step 4: Update ticket-detail Back button to reset all caches + route correctly**

Find the Back button's `onClick` inside `renderTicketDetail` (around line 919):

```javascript
onClick: function () {
  ticketsCache = null;
  mySubmissionsCountCache = null;
  showPanelView();
},
```

Replace with:

```javascript
onClick: function () {
  ticketsCache = null;
  mySubmissionsCountCache = null;
  updatesCache = null;
  showPanelView();
},
```

- [ ] **Step 5: Manual QA**

Restart the local dev server so the widget.js serving picks up changes:

```bash
cd /app/data/home/be
# if dev server is not running:
pnpm dev
```

Open the widget in a browser (e.g., the BE admin dashboard or an embed page). Verify:

1. Widget opens to the **Updates** tab by default
2. Done tickets appear, sorted most-recent first, with "Shipped Xd ago" timestamps
3. Clicking a card opens the detail view; clicking Back returns to Updates tab
4. Clicking "Recent Tickets" shows open tickets (as before)
5. Clicking "My Tickets" (when logged in) shows own submissions
6. When logged out: Updates and Recent Tickets work; "My Tickets" button is disabled with tooltip

- [ ] **Step 6: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): three-tab UI wired — Updates is default; tabs always rendered

All three views use shared handleTabChange. My Tickets button is disabled when unidentified. Back button invalidates updatesCache too so the Updates tab re-fetches after in-detail edits."
```

---

### Task 13: Phase 2 deploy / staging verification

- [ ] **Step 1: Run backend tests**

```bash
cd /app/data/home/be
pnpm vitest run src/api/services/WidgetService.updates-tab.test.ts src/api/services/WidgetService.ticket-detail.test.ts src/api/HttpServer.widget-comments.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Typecheck**

```bash
cd /app/data/home/be
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit any lint/formatter fixes**

If the formatter altered any files, stage and commit:

```bash
git status
# if anything staged:
git add -u
git commit -m "chore: formatter pass"
```

- [ ] **Step 4: STOP — user review checkpoint**

Do NOT deploy. Show the user the git log diff of Phase 1 + Phase 2, let them review, and wait for explicit approval before continuing to Phase 3. The user's CLAUDE.md says never deploy to production without explicit instruction; this checkpoint honors that.

---

# Phase 3 — Widget Frontend: Comment Composer + Edit/Delete

### Task 14: `formatAuthorName` helper and apply to timeline

**Files:**
- Modify: `public/widget.js`

- [ ] **Step 1: Add `formatAuthorName`**

Near `formatRelativeTime` (added in Task 11), add:

```javascript
function formatAuthorName(authorName, externalUserId, createdByType) {
  if (createdByType === "member") return authorName || "RunHQ member";
  if (authorName && externalUserId) return authorName + " (app-user id:" + externalUserId + ")";
  if (authorName) return authorName;
  if (externalUserId) return "app-user (id:" + externalUserId + ")";
  return "Anonymous";
}
```

- [ ] **Step 2: Apply in timeline rendering**

Find the timeline comment rendering (around line 1083):

```javascript
h("span", { className: "rw-timeline-author" },
  item.kind === "comment" ? (item.authorName || "Anonymous") : (item.createdByName || "System")),
```

Replace with:

```javascript
h("span", { className: "rw-timeline-author" },
  item.kind === "comment"
    ? formatAuthorName(item.authorName, item.externalUserId, item.createdByType)
    : (item.createdByName || "System")),
```

- [ ] **Step 3: Include new comment fields in the timeline builder**

Find the timeline-building block at lines 1064–1070:

```javascript
var timeline = [];
comments.forEach(function (c) {
  timeline.push({ kind: "comment", id: c.id, authorName: c.authorName, body: c.body, createdAt: c.createdAt });
});
```

Update to include the new fields:

```javascript
var timeline = [];
comments.forEach(function (c) {
  timeline.push({
    kind: "comment",
    id: c.id,
    authorName: c.authorName,
    externalUserId: c.externalUserId,
    createdByType: c.createdByType,
    isAuthorOfCurrentUser: c.isAuthorOfCurrentUser,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
});
```

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): explicit app-user labeling via formatAuthorName

External-authed commenters render as 'name (app-user id:…)' or 'app-user (id:…)' fallback. Members render as their name. Replaces prior 'Anonymous' fallback."
```

---

### Task 15: `(edited)` marker on edited comments

**Files:**
- Modify: `public/widget.js`

- [ ] **Step 1: Add CSS rule**

In the same style-string block used in Task 10 (CSS concatenation near line 704), add one more rule:

```javascript
".rw-edited-marker{color:" + textMuted + ";font-size:11px;margin-left:4px;cursor:help}" +
```

- [ ] **Step 2: Render the marker conditionally**

Find the cardHeader construction in the timeline rendering (around line 1082):

```javascript
var cardHeader = h("div", { className: "rw-timeline-card-header" }, [
  h("span", { className: "rw-timeline-author" }, /* ... */),
  h("span", { className: "rw-timeline-date" }, formatDate(item.createdAt)),
]);
```

Replace with:

```javascript
var headerChildren = [
  h("span", { className: "rw-timeline-author" },
    item.kind === "comment"
      ? formatAuthorName(item.authorName, item.externalUserId, item.createdByType)
      : (item.createdByName || "System")),
  h("span", { className: "rw-timeline-date" }, formatDate(item.createdAt)),
];
if (item.kind === "comment" && item.updatedAt && item.createdAt
    && new Date(item.updatedAt).getTime() > new Date(item.createdAt).getTime() + 1000) {
  headerChildren.push(h("span", {
    className: "rw-edited-marker",
    title: "Edited at " + formatDate(item.updatedAt),
  }, " (edited)"));
}
var cardHeader = h("div", { className: "rw-timeline-card-header" }, headerChildren);
```

(The `+ 1000` ms tolerance accounts for the small DB-write-time skew — two writes within a second are not considered "edited".)

- [ ] **Step 3: Manual QA**

After rebuilding, open the widget; verify existing comments do not show "(edited)". (No way to produce an edited comment yet — that's Task 17.)

- [ ] **Step 4: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): show (edited) marker on comments where updatedAt > createdAt

Tooltip on hover shows the edit timestamp (native title attribute, Discord-style)."
```

---

### Task 16: Comment composer inside ticket detail

**Files:**
- Modify: `public/widget.js`

- [ ] **Step 1: Add CSS rules**

In the style-string block, append:

```javascript
".rw-comment-composer{margin-top:12px;padding:10px;border:1px solid " + border + ";border-radius:8px;background:" + bgAlt + "}" +
".rw-comment-composer textarea{width:100%;min-height:60px;resize:vertical}" +
".rw-comment-composer-actions{display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px}" +
```

- [ ] **Step 2: Add `renderCommentComposer`**

Add above `renderTicketDetail` (around line 909):

```javascript
function renderCommentComposer(ticketId) {
  var noticeArea = h("div", null);
  var textarea = h("textarea", {
    className: "rw-input rw-textarea",
    placeholder: "Add a comment…",
    maxlength: "2000",
  });

  var pendingFiles = [];
  var preview = h("div", { className: "rw-attach-preview" });
  var fileInput = h("input", { type: "file", accept: "image/*", multiple: "true", style: "display:none" });
  fileInput.addEventListener("change", function () {
    Array.prototype.forEach.call(fileInput.files, function (f) {
      if (!f.type.startsWith("image/")) return;
      if (pendingFiles.length >= 5) return;
      pendingFiles.push(f);
      var reader = new FileReader();
      reader.onload = function (e) {
        var thumb = h("div", { className: "rw-edit-attach-item" }, [
          h("img", { className: "rw-edit-attach-img", src: e.target.result }),
          h("button", {
            className: "rw-edit-attach-remove",
            onClick: function () {
              var idx = pendingFiles.indexOf(f);
              if (idx > -1) pendingFiles.splice(idx, 1);
              thumb.remove();
            },
          }, "×"),
        ]);
        preview.appendChild(thumb);
      };
      reader.readAsDataURL(f);
    });
    fileInput.value = "";
  });

  var attachBtn = h("button", {
    className: "rw-inline-attach-btn",
    type: "button",
    onClick: function () { fileInput.click(); },
  }, "📎");

  var submitBtn = h("button", { className: "rw-inline-submit", type: "button" }, "Comment");
  submitBtn.addEventListener("click", function () {
    var content = textarea.value.trim();
    if (!content) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Posting…";
    noticeArea.innerHTML = "";
    postComment(ticketId, content).then(function (res) {
      var commentId = res.comment && res.comment.id;
      if (pendingFiles.length === 0) return;
      return pendingFiles.reduce(function (chain, f) {
        return chain.then(function () { return uploadCommentAttachment(ticketId, commentId, f); });
      }, Promise.resolve());
    }).then(function () {
      showTicketDetail(ticketId); // refresh
    }).catch(function (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Comment";
      noticeArea.innerHTML = "";
      noticeArea.appendChild(renderNotice("error", "Failed to post: " + err.message));
    });
  });

  var container = h("div", { className: "rw-comment-composer" }, [
    noticeArea,
    textarea,
    preview,
    fileInput,
    h("div", { className: "rw-comment-composer-actions" }, [attachBtn, submitBtn]),
  ]);
  return container;
}
```

- [ ] **Step 3: Call the composer from `renderTicketDetail`**

Find the end of `renderTicketDetail` right before `return container;` (around line 1104). Add:

```javascript
// Comment composer
if (config.isIdentified) {
  container.appendChild(h("hr", { className: "rw-divider" }));
  container.appendChild(renderCommentComposer(ticket.id));
} else {
  container.appendChild(h("hr", { className: "rw-divider" }));
  container.appendChild(h("div", { className: "rw-login-prompt" }, "Log in to comment"));
}

return container;
```

(Replace the existing bare `return container;` with the block above. Keep indentation consistent.)

- [ ] **Step 4: Manual QA**

Rebuild & open widget. Open a ticket. Log in (via embedding app). Verify:

1. Composer appears below the timeline
2. Typing content → submit → page refreshes and comment appears in timeline
3. Attach an image → submit → image appears in timeline as attachment
4. Logged-out state shows "Log in to comment" text instead of the composer

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): add comment composer inside ticket detail view

Supports text + up to 5 image attachments. Refreshes detail view on success. Shows login prompt for unauthenticated users."
```

---

### Task 17: Edit/delete actions on own comments

**Files:**
- Modify: `public/widget.js`

- [ ] **Step 1: Add CSS**

```javascript
".rw-comment-actions{display:flex;gap:6px;margin-top:6px}" +
".rw-comment-action-btn{font-size:11px;color:" + textMuted + ";background:transparent;border:none;cursor:pointer;padding:2px 4px}" +
".rw-comment-action-btn:hover{color:" + text + ";text-decoration:underline}" +
".rw-comment-edit-form{margin-top:6px}" +
".rw-comment-edit-form textarea{width:100%;min-height:50px;resize:vertical}" +
".rw-comment-edit-actions{display:flex;gap:6px;margin-top:6px}" +
```

- [ ] **Step 2: Add action row rendering**

In the timeline loop body (around line 1080, inside the `.forEach(function (item) {` block), just after the `cardBody` line for comments:

Find this block:

```javascript
if (item.kind === "comment") {
  cardBody = h("div", { className: "rw-timeline-body" }, item.body);
} else {
  cardBody = h("div", { className: "rw-timeline-activity" }, renderActivityLabel(item));
}
var card = h("div", { className: "rw-timeline-card" }, [cardHeader, cardBody]);
```

Replace with:

```javascript
var cardChildren;
if (item.kind === "comment") {
  cardBody = h("div", { className: "rw-timeline-body" }, item.body);
  cardChildren = [cardHeader, cardBody];
  if (item.isAuthorOfCurrentUser && config.isIdentified) {
    cardChildren.push(renderCommentActions(ticket.id, item));
  }
} else {
  cardBody = h("div", { className: "rw-timeline-activity" }, renderActivityLabel(item));
  cardChildren = [cardHeader, cardBody];
}
var card = h("div", { className: "rw-timeline-card" }, cardChildren);
```

- [ ] **Step 3: Add `renderCommentActions`**

Add near `renderCommentComposer`:

```javascript
function renderCommentActions(ticketId, comment) {
  var actionsRow = h("div", { className: "rw-comment-actions" });

  var editBtn = h("button", { className: "rw-comment-action-btn", type: "button" }, "Edit");
  editBtn.addEventListener("click", function () {
    var form = renderCommentEditForm(ticketId, comment);
    actionsRow.parentNode.replaceChild(form, actionsRow);
  });

  var deleteBtn = h("button", { className: "rw-comment-action-btn", type: "button" }, "Delete");
  deleteBtn.addEventListener("click", function () {
    var confirmBox = h("div", { className: "rw-delete-confirm" }, [
      h("p", null, "Delete this comment?"),
      h("div", { className: "rw-delete-confirm-actions" }, [
        h("button", {
          className: "rw-delete-yes",
          onClick: function () {
            removeComment(ticketId, comment.id).then(function () {
              showTicketDetail(ticketId);
            }).catch(function (err) {
              confirmBox.innerHTML = "";
              confirmBox.appendChild(renderNotice("error", "Failed: " + err.message));
            });
          },
        }, "Delete"),
        h("button", {
          className: "rw-delete-cancel",
          onClick: function () { confirmBox.parentNode.replaceChild(actionsRow, confirmBox); },
        }, "Cancel"),
      ]),
    ]);
    actionsRow.parentNode.replaceChild(confirmBox, actionsRow);
  });

  actionsRow.appendChild(editBtn);
  actionsRow.appendChild(deleteBtn);
  return actionsRow;
}

function renderCommentEditForm(ticketId, comment) {
  var textarea = h("textarea", {
    className: "rw-input rw-textarea",
    maxlength: "2000",
  });
  textarea.value = comment.body;
  var noticeArea = h("div", null);

  var saveBtn = h("button", { className: "rw-save-btn", type: "button" }, "Save");
  var cancelBtn = h("button", { className: "rw-cancel-btn", type: "button" }, "Cancel");

  var form = h("div", { className: "rw-comment-edit-form" }, [
    noticeArea,
    textarea,
    h("div", { className: "rw-comment-edit-actions" }, [saveBtn, cancelBtn]),
  ]);

  saveBtn.addEventListener("click", function () {
    var content = textarea.value.trim();
    if (!content) {
      noticeArea.innerHTML = "";
      noticeArea.appendChild(renderNotice("error", "Content required"));
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    editComment(ticketId, comment.id, content).then(function () {
      showTicketDetail(ticketId);
    }).catch(function (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      noticeArea.innerHTML = "";
      noticeArea.appendChild(renderNotice("error", "Failed: " + err.message));
    });
  });

  cancelBtn.addEventListener("click", function () {
    var actions = renderCommentActions(ticketId, comment);
    form.parentNode.replaceChild(actions, form);
  });

  return form;
}
```

- [ ] **Step 4: Manual QA**

Rebuild and test:

1. Post a comment as logged-in user
2. Verify Edit/Delete appear on your own comment (not on others' / not when logged out)
3. Click Edit → textarea appears pre-filled → change → Save → comment updates + "(edited)" appears
4. Click Delete → confirm prompt → confirm → comment disappears
5. Try editing someone else's comment (should be impossible from UI)

- [ ] **Step 5: Commit**

```bash
cd /app/data/home/be
git add public/widget.js
git commit -m "feat(widget): add edit/delete actions on own comments

Inline edit form (textarea + Save/Cancel) replaces the action row. Delete shows a confirm prompt. Author-only visibility enforced from isAuthorOfCurrentUser flag on the comment payload (backend double-checks)."
```

---

### Task 18: Cross-surface persistence sanity check

**Files:** none (verification-only)

- [ ] **Step 1: Post from widget → read in RunHQ**

1. Post a comment on a ticket via the widget
2. Open the corresponding task in the RunHQ app (at `/workspace/<server>/.../tasks/<id>` or wherever the app surfaces tickets)
3. Verify the comment appears, attributed to the external user

- [ ] **Step 2: Post from RunHQ → read in widget**

1. Post a comment on the same task from the RunHQ app
2. Refresh the widget → open the ticket
3. Verify the member-authored comment appears in the widget timeline with `createdByType: 'member'` labeling (no `app-user` annotation — just the name)

- [ ] **Step 3: Document result**

If both work: write up a short note in the commit message of the next commit. If either fails: debug before moving on. Do not treat this as optional.

---

### Task 19: E2E test

**Files:**
- Create: `e2e/widget-updates-and-comments.spec.ts` (or follow existing `/app/data/home/widget/e2e/` patterns if Playwright lives there)

- [ ] **Step 1: Check for existing Playwright infrastructure**

```bash
ls /app/data/home/be/e2e/ 2>/dev/null
ls /app/data/home/widget/e2e/ 2>/dev/null
ls /app/data/home/be/playwright.config.ts 2>/dev/null
ls /app/data/home/widget/playwright.config.ts 2>/dev/null
```

If Playwright is configured in `/app/data/home/widget` but not in `/app/data/home/be`: document the widget behavior in a manual QA checklist file instead (`docs/widget-e2e-manual-qa.md`).

If Playwright is configured in `/app/data/home/be`: write a spec using the existing config.

- [ ] **Step 2: Author the E2E (or manual QA doc)**

Either:

**(a) Playwright spec** covering:
- Tabs render when unidentified; Updates and Recent Tickets load; My Tickets is disabled
- After login: My Tickets becomes enabled, loads
- Updates list only shows done tickets, newest first
- Click card → detail → comment composer works
- Edit own comment → "(edited)" appears with tooltip
- Delete own comment → removed from timeline
- Post in widget, reload RunHQ task view → comment visible

**(b) Manual QA checklist** at `docs/widget-e2e-manual-qa.md`:

```markdown
# Widget Updates + Commenting — Manual QA

## Setup
- A widget-enabled project with at least 3 done tickets, 2 open, 1 cancelled
- A signed-in user in the embedding app

## Tabs
- [ ] Open widget → lands on Updates tab
- [ ] Updates tab shows done tickets only, newest first, relative times ("Xd ago")
- [ ] Empty-state text "Nothing shipped yet." when no done tickets
- [ ] Recent Tickets shows open tickets (not done / not cancelled)
- [ ] My Tickets badge shows count when logged in
- [ ] My Tickets button is disabled when logged out (tooltip: "Log in to view your tickets")

## Commenting
- [ ] Open ticket detail → composer visible when logged in
- [ ] Post text comment → appears in timeline
- [ ] Post comment with image → attachment appears in timeline
- [ ] Post 5 attachments → 6th is silently rejected
- [ ] Composer hidden + "Log in to comment" shown when logged out

## Edit/Delete
- [ ] Edit own comment → "(edited)" appears with hover tooltip
- [ ] Cannot see Edit/Delete on other users' comments
- [ ] Delete own comment with confirm → removed from timeline

## Cross-surface
- [ ] Comment posted in widget appears in RunHQ app task detail
- [ ] Comment posted in RunHQ app appears in widget timeline (as 'member' type, no "(app-user)" suffix)

## Labeling
- [ ] External commenter shows as "name (app-user id:…)"
- [ ] External commenter without name shows as "app-user (id:…)"
- [ ] RunHQ-member commenter shows as just the name
```

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/be
git add e2e/ docs/widget-e2e-manual-qa.md 2>/dev/null || git add docs/widget-e2e-manual-qa.md
git commit -m "test(widget): E2E coverage for Updates tab + commenting"
```

---

## Self-Review Checklist (run before declaring complete)

- [ ] **Phase 1 complete:** `pnpm vitest run src/api/services/WorkspaceTaskService.updateComment.test.ts src/api/services/WidgetService.updates-tab.test.ts src/api/services/WidgetService.ticket-detail.test.ts src/api/services/WidgetService.comments.test.ts src/api/HttpServer.widget-comments.test.ts` all pass
- [ ] **Typecheck:** `pnpm typecheck` clean
- [ ] **Widget smoke test:** open widget → Updates tab is default and loads; Recent Tickets and My Tickets still work; comment composer posts + edits + deletes; "(edited)" marker shows with hover tooltip
- [ ] **Cross-surface:** widget → RunHQ sync verified in both directions
- [ ] **Label correctness:** external user → "name (app-user id:…)"; member → plain name
- [ ] **Spec coverage:** Every section of `docs/superpowers/specs/2026-04-22-widget-updates-tab-and-comments-design.md` Ship-1 has a corresponding task above

## Out of Scope (handled by separate future plan)

- RunHQ-native OAuth login flow (Ship-2 — see spec appendix)
- `isPublic` help-text update (Ship-2 — cosmetic; combine with OAuth work)
- Any schema migrations (Ship-1 explicitly needs none)
