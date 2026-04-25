# Widget Metadata Capture & Display

## Problem

The feedback widget (`public/widget.js`) already captures rich browser context on every submission — URL, user agent, viewport size, console logs, JS errors, locale, etc. This context is sent in the POST body to `/api/widget/tickets`, but the backend ignores it entirely. `WidgetService.createTicket()` only reads `title`, `description`, and `isPrivate`.

## Goal

Store the widget-submitted browser metadata in the database and display it in the workspace task detail panel for human reviewers.

## Security: Prompt Injection Mitigation

Console logs, error messages, and URLs could contain adversarial strings designed to manipulate AI agents that read task descriptions. The mitigation is simple: **never pass metadata to the AI agent**. Metadata is stored separately from the description and is display-only for human reviewers in the workspace UI. The agent task-reading code paths must exclude the `metadata` field.

## Metadata Schema

The context object sent by the widget:

```typescript
interface WidgetSubmissionMetadata {
  url?: string;
  referrer?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  screenSize?: { width: number; height: number };
  locale?: string;
  timestamp?: string;
  consoleLogs?: Array<{ level: string; message: string; ts: string }>;
  errors?: Array<{ type: string; message: string; source?: string; line?: number; col?: number; stack?: string; ts: string }>;
}
```

## Changes

### BE repo (`/app/data/home/be`)

#### 1. Database schema — add `metadata` column

File: `src/db/schema.ts`

Add a nullable JSONB column `metadata` to the `workspace_tasks` table.

#### 2. WidgetService — store metadata on ticket creation

File: `src/api/services/WidgetService.ts`

- Update `createTicket()` signature to accept `metadata` in opts
- Sanitize before storing: truncate excessively long strings (e.g., 10KB cap on individual log messages), cap `consoleLogs` and `errors` arrays to 50 entries, strip any keys not in the known schema
- Store the sanitized metadata in the new column

#### 3. Protocol — add `metadata` to CanonicalTask

File: `packages/protocol/src/index.ts`

Add `metadata?: Record<string, unknown> | null` to the `CanonicalTask` interface.

#### 4. WorkspaceTaskService — include metadata in canonical task mapping

File: `src/api/services/WorkspaceTaskService.ts`

Add `metadata` to `toCanonicalTask()` mapping.

#### 5. Agent task-reading — exclude metadata

Ensure that any code path where an AI agent reads a task description does NOT include the `metadata` field. This is the primary prompt injection mitigation.

### Workspace repo (`/app/data/home/runhq`)

#### 6. Protocol — mirror metadata field

File: `packages/protocol/src/index.ts`

Add `metadata?: Record<string, unknown> | null` to both `CanonicalTask` and `Todo` interfaces.

#### 7. Task sync — pass metadata through

File: `server/src/http/routes/todos.ts`

Map `metadata` in `mergeTodoWithCanonicalTask()`.

#### 8. UI — collapsible "Browser Context" section

File: `client/src/components/TodoView.tsx`

Below the description in `TodoDetailPanel`, when `sourceType === 'widget'` and `metadata` exists, render a collapsible section:

```
> Browser Context
  URL: https://example.com/dashboard
  Browser: Chrome 126 / macOS  (parsed from userAgent)
  Viewport: 1440x900 | Screen: 2560x1440
  Locale: en-US
  Submitted: 2026-04-16T10:30:00Z
  > Console Logs (12)     -- expandable, code-block style
  > Errors (2)            -- expandable, code-block style
```

- Collapsed by default to avoid visual clutter
- Console logs shown in a monospace code block with level-based coloring (warn=amber, error=red)
- Errors shown with message, source file, line:col, and collapsible stack trace

### No changes needed to widget.js

The client already collects and sends all this metadata. No frontend widget changes required.

## Migration

Run `pnpm db:push` after schema change to sync the new column to the database. The column is nullable, so no backfill needed — existing tasks will have `metadata: null`.
