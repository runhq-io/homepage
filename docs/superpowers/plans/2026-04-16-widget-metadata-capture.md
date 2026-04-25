# Widget Metadata Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store widget-submitted browser metadata (URL, userAgent, viewport, console logs, JS errors) in the database and display it in the workspace task detail panel — while keeping it invisible to AI agents.

**Architecture:** Add a nullable JSONB `metadata` column to `workspace_tasks`, pipe it through the `CanonicalTask` protocol type, and render it as a collapsible "Browser Context" section in the workspace `TodoDetailPanel`. The widget client already sends this data — no widget.js changes needed. Agent code paths (`ServerToolExecutor`, `TaskExecutionContextService`) already exclude metadata and must remain unchanged.

**Tech Stack:** PostgreSQL/Drizzle ORM, TypeScript, Hono, React, Tailwind CSS, lucide-react icons

---

## File Map

### BE repo (`/app/data/home/be`)

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/db/schema.ts:1015-1046` | Add `metadata` JSONB column to `workspace_tasks` |
| Modify | `packages/protocol/src/index.ts:306-336` | Add `metadata` to `CanonicalTask` interface |
| Modify | `src/api/services/WidgetService.ts:473-535` | Accept & sanitize metadata in `createTicket()` |
| Modify | `src/api/services/WorkspaceTaskService.ts:124-156` | Include `metadata` in `toCanonicalTask()` |

### Workspace repo (`/app/data/home/runhq`)

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/protocol/src/index.ts:308-336` | Add `metadata` to `CanonicalTask` interface |
| Modify | `packages/protocol/src/index.ts:168-208` | Add `metadata` to `Todo` interface |
| Modify | `server/src/http/routes/todos.ts:157-182` | Map `metadata` in `mergeTodoWithCanonicalTask()` |
| Modify | `client/src/components/TodoView.tsx:2249-2296` | Add collapsible Browser Context section |

### Files that must NOT change (agent code paths — prompt injection safety)

| File | Why |
|------|-----|
| `server/src/services/ServerToolExecutor.ts:1710-1756` | Agent reads task here — must not include metadata |
| `server/src/services/TaskExecutionContextService.ts:150-153` | Agent builds task context here — must not include metadata |

---

## Task 1: Add `metadata` column to database schema

**Files:**
- Modify: `src/db/schema.ts:1015-1046`

- [ ] **Step 1: Add the metadata column**

In `/app/data/home/be/src/db/schema.ts`, add a `metadata` column to the `workspaceTasks` table definition, after the `moderationStatus` line (line 1038):

```typescript
metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
```

Ensure `jsonb` is already imported from `drizzle-orm/pg-core` (it should be — the schema already uses `jsonb` for `workspaceTaskActivity.metadata`).

- [ ] **Step 2: Push schema to database**

Run: `cd /app/data/home/be && pnpm db:push`
Expected: Schema synced successfully, new `metadata` column added to `workspace_tasks`.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: add metadata JSONB column to workspace_tasks table"
```

---

## Task 2: Add `metadata` to `CanonicalTask` in BE protocol

**Files:**
- Modify: `packages/protocol/src/index.ts:306-336`

- [ ] **Step 1: Add metadata field to CanonicalTask**

In `/app/data/home/be/packages/protocol/src/index.ts`, add to the `CanonicalTask` interface after the `attachments` field (line 333):

```typescript
metadata?: Record<string, unknown> | null;
```

- [ ] **Step 2: Commit**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat: add metadata field to CanonicalTask protocol type"
```

---

## Task 3: Store metadata in `WidgetService.createTicket()`

**Files:**
- Modify: `src/api/services/WidgetService.ts:473-535`

- [ ] **Step 1: Add sanitization helper**

Add a `sanitizeWidgetMetadata` function above `createTicket()` in `WidgetService.ts`. This function validates and truncates metadata to prevent abuse (massive payloads, unexpected fields):

```typescript
const ALLOWED_METADATA_KEYS = new Set([
  'url', 'referrer', 'userAgent', 'viewport', 'screenSize',
  'locale', 'timestamp', 'consoleLogs', 'errors',
]);
const MAX_STRING_LENGTH = 2048;
const MAX_LOG_ENTRIES = 50;
const MAX_LOG_MESSAGE_LENGTH = 1024;

function sanitizeWidgetMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const input = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    const val = input[key];

    if (key === 'url' || key === 'referrer' || key === 'userAgent' || key === 'locale' || key === 'timestamp') {
      if (typeof val === 'string') result[key] = val.slice(0, MAX_STRING_LENGTH);
    } else if (key === 'viewport' || key === 'screenSize') {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>;
        if (typeof obj.width === 'number' && typeof obj.height === 'number') {
          result[key] = { width: obj.width, height: obj.height };
        }
      }
    } else if (key === 'consoleLogs') {
      if (Array.isArray(val)) {
        result[key] = val.slice(0, MAX_LOG_ENTRIES).map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          return {
            level: typeof e.level === 'string' ? e.level.slice(0, 10) : 'log',
            message: typeof e.message === 'string' ? e.message.slice(0, MAX_LOG_MESSAGE_LENGTH) : '',
            ts: typeof e.ts === 'string' ? e.ts.slice(0, 30) : '',
          };
        }).filter(Boolean);
      }
    } else if (key === 'errors') {
      if (Array.isArray(val)) {
        result[key] = val.slice(0, MAX_LOG_ENTRIES).map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          return {
            type: typeof e.type === 'string' ? e.type.slice(0, 50) : 'error',
            message: typeof e.message === 'string' ? e.message.slice(0, MAX_LOG_MESSAGE_LENGTH) : '',
            source: typeof e.source === 'string' ? e.source.slice(0, MAX_STRING_LENGTH) : undefined,
            line: typeof e.line === 'number' ? e.line : undefined,
            col: typeof e.col === 'number' ? e.col : undefined,
            stack: typeof e.stack === 'string' ? e.stack.slice(0, MAX_STRING_LENGTH) : undefined,
            ts: typeof e.ts === 'string' ? e.ts.slice(0, 30) : '',
          };
        }).filter(Boolean);
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
```

- [ ] **Step 2: Update createTicket to accept and store metadata**

Update the `opts` parameter type and the insert call in `createTicket()`:

Change the function signature from:
```typescript
export async function createTicket(
  projectId: string,
  widgetUserId: string | undefined,
  opts: { title?: string; description?: string; isPrivate?: boolean }
)
```
To:
```typescript
export async function createTicket(
  projectId: string,
  widgetUserId: string | undefined,
  opts: { title?: string; description?: string; isPrivate?: boolean; context?: unknown }
)
```

Add metadata sanitization before the insert, and include it in the values:

```typescript
const metadata = sanitizeWidgetMetadata(opts.context);
```

Then add `metadata,` to the `.values({...})` object in the `db.insert(workspaceTasks)` call (after `votingEndsAt`).

- [ ] **Step 3: Commit**

```bash
git add src/api/services/WidgetService.ts
git commit -m "feat: accept and store widget metadata in createTicket"
```

---

## Task 4: Include metadata in `toCanonicalTask()` mapping

**Files:**
- Modify: `src/api/services/WorkspaceTaskService.ts:124-156`

- [ ] **Step 1: Add metadata to toCanonicalTask**

In `/app/data/home/be/src/api/services/WorkspaceTaskService.ts`, in the `toCanonicalTask` function, add after the `updatedAt` line (line 154):

```typescript
metadata: row.metadata as Record<string, unknown> | null ?? null,
```

- [ ] **Step 2: Commit**

```bash
git add src/api/services/WorkspaceTaskService.ts
git commit -m "feat: include metadata in canonical task mapping"
```

---

## Task 5: Add `metadata` to workspace protocol types

**Files:**
- Modify: `packages/protocol/src/index.ts` in `/app/data/home/runhq`

- [ ] **Step 1: Add metadata to CanonicalTask**

In `/app/data/home/runhq/packages/protocol/src/index.ts`, add to the `CanonicalTask` interface after the `attachments` field (line 335):

```typescript
metadata?: Record<string, unknown> | null;
```

- [ ] **Step 2: Add metadata to Todo**

In the same file, add to the `Todo` interface after the `moderationStatus` field (line 204):

```typescript
metadata?: Record<string, unknown> | null;
```

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/runhq
git add packages/protocol/src/index.ts
git commit -m "feat: add metadata field to CanonicalTask and Todo types"
```

---

## Task 6: Map metadata in canonical task sync

**Files:**
- Modify: `server/src/http/routes/todos.ts:157-182` in `/app/data/home/runhq`

- [ ] **Step 1: Add metadata to mergeTodoWithCanonicalTask**

In `/app/data/home/runhq/server/src/http/routes/todos.ts`, in the `mergeTodoWithCanonicalTask` function, add after the `sourceType` line (line 180):

```typescript
metadata: canonicalTask.metadata ?? null,
```

- [ ] **Step 2: Commit**

```bash
cd /app/data/home/runhq
git add server/src/http/routes/todos.ts
git commit -m "feat: pass metadata through canonical task sync"
```

---

## Task 7: Add Browser Context section to TodoDetailPanel

**Files:**
- Modify: `client/src/components/TodoView.tsx:2249-2296` in `/app/data/home/runhq`

- [ ] **Step 1: Add the BrowserContext component**

Add a new component above `TodoDetailPanel` (before line 1806) in `TodoView.tsx`. This is a self-contained collapsible section that renders widget metadata:

```tsx
const BrowserContextSection: React.FC<{ metadata: Record<string, unknown> }> = ({ metadata }) => {
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const url = typeof metadata.url === 'string' ? metadata.url : null;
  const referrer = typeof metadata.referrer === 'string' ? metadata.referrer : null;
  const userAgent = typeof metadata.userAgent === 'string' ? metadata.userAgent : null;
  const viewport = metadata.viewport as { width: number; height: number } | undefined;
  const screenSize = metadata.screenSize as { width: number; height: number } | undefined;
  const locale = typeof metadata.locale === 'string' ? metadata.locale : null;
  const timestamp = typeof metadata.timestamp === 'string' ? metadata.timestamp : null;
  const consoleLogs = Array.isArray(metadata.consoleLogs) ? metadata.consoleLogs as Array<{ level: string; message: string; ts: string }> : [];
  const errors = Array.isArray(metadata.errors) ? metadata.errors as Array<{ type: string; message: string; source?: string; line?: number; col?: number; stack?: string; ts: string }> : [];

  const logLevelColor: Record<string, string> = {
    error: 'text-red-400',
    warn: 'text-amber-400',
    info: 'text-blue-400',
    log: 'text-slate-400',
  };

  return (
    <div className="border-t border-slate-700/50">
      <button
        className="flex items-center gap-1.5 w-full px-5 py-2 text-xs font-medium text-slate-400 hover:text-slate-300 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Globe className="w-3 h-3" />
        Browser Context
      </button>

      {expanded && (
        <div className="px-5 pb-3 space-y-1.5 text-xs text-slate-400">
          {url && (
            <div className="flex gap-2">
              <span className="text-slate-500 shrink-0 w-16">URL</span>
              <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">{url}</a>
            </div>
          )}
          {referrer && (
            <div className="flex gap-2">
              <span className="text-slate-500 shrink-0 w-16">Referrer</span>
              <span className="truncate">{referrer}</span>
            </div>
          )}
          {userAgent && (
            <div className="flex gap-2">
              <span className="text-slate-500 shrink-0 w-16">Browser</span>
              <span className="truncate">{userAgent}</span>
            </div>
          )}
          {(viewport || screenSize) && (
            <div className="flex gap-2">
              <span className="text-slate-500 shrink-0 w-16">Display</span>
              <span>
                {viewport ? `${viewport.width}\u00d7${viewport.height}` : ''}
                {viewport && screenSize ? ' \u00b7 ' : ''}
                {screenSize ? `Screen ${screenSize.width}\u00d7${screenSize.height}` : ''}
              </span>
            </div>
          )}
          {locale && (
            <div className="flex gap-2">
              <span className="text-slate-500 shrink-0 w-16">Locale</span>
              <span>{locale}</span>
            </div>
          )}
          {timestamp && (
            <div className="flex gap-2">
              <span className="text-slate-500 shrink-0 w-16">Sent</span>
              <span>{new Date(timestamp).toLocaleString()}</span>
            </div>
          )}

          {consoleLogs.length > 0 && (
            <div className="mt-2">
              <button
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-300"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Console Logs ({consoleLogs.length})
              </button>
              {showLogs && (
                <div className="mt-1 max-h-48 overflow-y-auto rounded bg-slate-900/60 p-2 font-mono text-[11px] space-y-0.5">
                  {consoleLogs.map((log, i) => (
                    <div key={i} className={logLevelColor[log.level] || 'text-slate-400'}>
                      <span className="text-slate-600 mr-1.5">[{log.level}]</span>
                      {log.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {errors.length > 0 && (
            <div className="mt-2">
              <button
                className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
                onClick={() => setShowErrors(!showErrors)}
              >
                {showErrors ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Errors ({errors.length})
              </button>
              {showErrors && (
                <div className="mt-1 max-h-48 overflow-y-auto rounded bg-slate-900/60 p-2 font-mono text-[11px] space-y-1.5">
                  {errors.map((err, i) => (
                    <div key={i} className="text-red-400">
                      <div>{err.message}</div>
                      {err.source && (
                        <div className="text-slate-500 ml-2">
                          at {err.source}{err.line != null ? `:${err.line}` : ''}{err.col != null ? `:${err.col}` : ''}
                        </div>
                      )}
                      {err.stack && (
                        <pre className="text-slate-600 ml-2 whitespace-pre-wrap text-[10px]">{err.stack}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Render BrowserContextSection in TodoDetailPanel**

In the `TodoDetailPanel` component, insert the `BrowserContextSection` after the description/author block and before the schedule settings section. Specifically, after the closing `</div>` of the description `px-5 py-3` div (line 2296), add:

```tsx
{todo.sourceType === 'widget' && todo.metadata && typeof todo.metadata === 'object' && (
  <BrowserContextSection metadata={todo.metadata} />
)}
```

- [ ] **Step 3: Commit**

```bash
cd /app/data/home/runhq
git add client/src/components/TodoView.tsx
git commit -m "feat: display widget browser context in task detail panel"
```

---

## Task 8: Verify agent code paths exclude metadata

**Files:**
- Read-only check: `server/src/services/ServerToolExecutor.ts:1710-1756`
- Read-only check: `server/src/services/TaskExecutionContextService.ts:150-160`

- [ ] **Step 1: Verify ServerToolExecutor.executeTaskGetTool**

Open `/app/data/home/runhq/server/src/services/ServerToolExecutor.ts` at line 1710. Confirm the `executeTaskGetTool` method builds its output string from `task.title`, `task.description`, `task.status`, etc. — and does NOT reference `task.metadata`. No changes needed.

- [ ] **Step 2: Verify TaskExecutionContextService.buildTaskDetailsBlock**

Open `/app/data/home/runhq/server/src/services/TaskExecutionContextService.ts` at line 150. Confirm `buildTaskDetailsBlock` uses `task.title`, `task.description`, and `task.attachments` — and does NOT reference `task.metadata`. No changes needed.

- [ ] **Step 3: Document in commit**

No code changes. This is a verification step. If both are clean, proceed.

---

## Execution Order

Tasks 1-4 are in the BE repo (`/app/data/home/be`), sequential.
Tasks 5-8 are in the workspace repo (`/app/data/home/runhq`), sequential.
Tasks 1-4 and 5-8 can be done in parallel across repos since they have no compile-time dependency (protocol types are mirrored, not shared at build time).
