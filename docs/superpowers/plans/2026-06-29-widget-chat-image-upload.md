# Widget Chat Image Upload (Multimodal) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an identified widget visitor attach/paste an image in the support-agent chat composer; the image is screened, downscaled for the model, shown live to the vision-capable chat agent, and carried onto any created ticket.

**Architecture:** Reuse the existing widget image pipeline (injection guard + R2/S3 storage). A new chat-image upload endpoint stores the original plus a ≤1024px model-optimized derivative and records refs on the chat message's `payload`. The BE→workspace turn transcript carries the base64 derivative on the user row; the runhq `buildLoopMessages` emits Anthropic image content blocks with a `cache_control` breakpoint so re-sends are cached. On ticket creation, originals become task attachments.

**Tech Stack:** TypeScript (Node/Hono) BE, Drizzle ORM, R2/S3 (`attachmentStorage`), `sharp` (new dep, image resize), vanilla JS widget (`public/widget.js`), Anthropic content blocks via `createAgentLoop` (runhq).

## Global Constraints

- Image types allowed: `image/jpeg`, `image/png`, `image/gif`, `image/webp` only (SVG excluded). Copy from `ALLOWED_IMAGE_TYPES` in `be/src/api/services/WidgetService.ts`.
- Max upload size: **5 MB** (`MAX_ATTACHMENT_SIZE`). Max **3 images per chat message**, **5 per conversation**.
- Model-facing derivative: **≤1024 px on the long edge**, re-encoded JPEG quality ~80, EXIF stripped.
- Every uploaded image MUST pass `requireSafeTicketAndImages` (fail-closed injection guard) BEFORE storage.
- Upload requires an identified widget user (existing chat gate) AND `attach_image` RBAC (`WidgetService.canAttachImages`).
- `be` deploy is via PR (see `be/HOW_TO_DEPLOY.md`); adding `sharp` (native dep) requires an **image rebuild** before deploy (see `runhq` memory `stale-image-missing-npm-dep` — new npm deps are not picked up by hot-deploy).
- The transcript `images` field is **additive/backward-compatible**: older workspace ignores it; older BE never sends it. Deploy BE and runhq independently in any order.
- **Storage-ownership boundary (security):** the server owns all R2/S3 storage references. The client NEVER sends storage keys. Uploaded image refs are persisted in a server-side `widget_chat_images` table; the client only ever receives/sends an opaque `imageId` (the row id), which the server validates against `(conversationId, widgetUserId)` before use. (Mirrors the existing rule in `HttpServer.ts` ~4989–4994.)
- runhq tasks (6–7) are implemented in a separate runhq worktree off `origin/master`; BE tasks (1–5, 8–9) in the `be` worktree `widget-chat-image-upload`.

---

## File Structure

**be:**
- `package.json` — add `sharp`.
- `src/api/services/widgetChatImage.ts` (new) — `resizeForModel()` pure util.
- `src/db/schema.ts` — new `widgetChatImages` table (server-side ref store, FK to conversation + nullable `messageId`); + migration.
- `src/api/services/WidgetService.ts` — `storeWidgetChatImage()` (stores objects + inserts a `widget_chat_images` row), `resizeForModel` consumer, `MAX_*` consts.
- `src/api/services/WidgetChatService.ts` — `attachConversationImage`, `sendUserMessage(imageIds)` (validate + link), `buildTranscript` image inlining (read table by messageId), `dispatchTurn`, `createTicketFromChat` carry-over, `PublicChatImage` DTO type.
- `src/api/HttpServer.ts` — `POST /api/widget/chat/conversations/:id/images` (returns only safe public fields, never storage keys); `chatMessageDto` joins `widget_chat_images` by messageId; messages route forwards `imageIds`.
- `public/widget.js` — chat composer attach/paste + preview + upload + send-with-`imageIds` + render in bubble.

**runhq:**
- `server/src/http/routes/widget-chat-turn.ts` — extend `transcriptRowSchema` user row with `images`.
- `server/src/services/WidgetChatSessionManager.ts` — extend `WidgetChatTranscriptRow`; `buildLoopMessages` image blocks + cache breakpoint.

---

## Task 1: `resizeForModel` derivative util (be)

**Files:**
- Create: `be/src/api/services/widgetChatImage.ts`
- Test: `be/src/api/services/widgetChatImage.test.ts`
- Modify: `be/package.json` (add `sharp`)

**Interfaces:**
- Produces: `resizeForModel(buffer: Buffer, mime: string): Promise<{ buffer: Buffer; mime: 'image/jpeg'; width: number; height: number }>` — downscales so the long edge ≤ 1024, re-encodes JPEG q80, strips metadata. Images already ≤1024 are still re-encoded (normalizes format + strips EXIF).

- [ ] **Step 1: Add sharp**

Run: `cd be && pnpm add sharp`
Expected: `sharp` appears in `package.json` dependencies and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write the failing test**

```typescript
// be/src/api/services/widgetChatImage.test.ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizeForModel } from './widgetChatImage';

async function makePng(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png().toBuffer();
}

describe('resizeForModel', () => {
  it('downscales the long edge to <=1024 and outputs jpeg', async () => {
    const src = await makePng(4000, 2000);
    const out = await resizeForModel(src, 'image/png');
    expect(out.mime).toBe('image/jpeg');
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1024);
    expect(out.width / out.height).toBeCloseTo(2, 1);
    expect(out.buffer.length).toBeLessThan(src.length);
  });

  it('re-encodes small images without upscaling', async () => {
    const src = await makePng(300, 200);
    const out = await resizeForModel(src, 'image/png');
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    expect(out.mime).toBe('image/jpeg');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd be && pnpm vitest run src/api/services/widgetChatImage.test.ts`
Expected: FAIL — `resizeForModel` not exported.

- [ ] **Step 4: Implement**

```typescript
// be/src/api/services/widgetChatImage.ts
import sharp from 'sharp';

/** Long-edge cap for the model-facing image. Vision tokens scale with pixel area;
 *  1024px keeps UI text legible at ~1k tokens / ~$0.005 per send on Opus 4.8. */
export const MODEL_IMAGE_MAX_EDGE = 1024;

export async function resizeForModel(
  buffer: Buffer,
  _mime: string,
): Promise<{ buffer: Buffer; mime: 'image/jpeg'; width: number; height: number }> {
  const out = await sharp(buffer)
    .rotate() // bake in EXIF orientation, then strip metadata (default)
    .resize({
      width: MODEL_IMAGE_MAX_EDGE,
      height: MODEL_IMAGE_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, mime: 'image/jpeg', width: out.info.width, height: out.info.height };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd be && pnpm vitest run src/api/services/widgetChatImage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd be && git add package.json pnpm-lock.yaml src/api/services/widgetChatImage.ts src/api/services/widgetChatImage.test.ts
git commit -m "feat(widget-chat): add resizeForModel image derivative util"
```

---

## Task 2: `widget_chat_images` table + `storeWidgetChatImage` service (be)

**Files:**
- Modify: `be/src/db/schema.ts` (new `widgetChatImages` table)
- Create: `be/drizzle/<generated>.sql` (migration)
- Modify: `be/src/api/services/WidgetService.ts` (`storeWidgetChatImage`, consts, `ChatImageRow` type)
- Test: `be/src/api/services/WidgetService.widgetChatImage.test.ts`

**Interfaces:**
- Consumes: `attachmentStorage.storeUpload({serverId, body, mimeType, filename, originalName, ownerType})`, `attachmentStorage.deleteStoredObject(...)`, `requireSafeTicketAndImages(reviewTicket, files, opts)`, `assertWidgetImageFile`, `resizeForModel`.
- Produces:
  - Table `widget_chat_images` with columns: `id` (uuid pk), `conversationId` (fk → widget_chat_conversations), `widgetUserId`, `messageId` (uuid, **nullable** — set when the image is sent with a message), `serverId`, `mimeType`, `originalName`, `originalStorageProvider`, `originalStorageKey`, `modelStorageProvider`, `modelStorageKey`, `width`, `height`, `createdAt`.
  - `storeWidgetChatImage(projectId, conversationId, widgetUserId, permissions, file): Promise<ChatImageRow>` — screens, stores original + derivative, inserts a row with `messageId = null`, returns the row. **The row id is the only handle the client receives.**
  - `MAX_CHAT_IMAGES_PER_MESSAGE = 3`, `MAX_CHAT_IMAGES_PER_CONVERSATION = 5`.

- [ ] **Step 1: Add the table + migration**

```typescript
// be/src/db/schema.ts
export const widgetChatImages = pgTable('widget_chat_images', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: uuid('conversation_id').notNull()
    .references(() => widgetChatConversations.id, { onDelete: 'cascade' }),
  widgetUserId: text('widget_user_id').notNull(),
  messageId: uuid('message_id').references(() => widgetChatMessages.id, { onDelete: 'cascade' }), // nullable
  serverId: uuid('server_id').notNull(),
  mimeType: text('mime_type').notNull(),
  originalName: text('original_name'),
  originalStorageProvider: text('original_storage_provider').notNull(),
  originalStorageKey: text('original_storage_key').notNull(),
  modelStorageProvider: text('model_storage_provider').notNull(),
  modelStorageKey: text('model_storage_key').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
export type ChatImageRow = typeof widgetChatImages.$inferSelect;
```
(Match the column types of neighbouring tables — confirm whether ids are `uuid` or `text` in `widget_chat_conversations`/`widget_chat_messages` and align.)
Run: `cd be && pnpm drizzle-kit generate` → commit the generated migration.

- [ ] **Step 2: Write the failing test**

```typescript
// be/src/api/services/WidgetService.widgetChatImage.test.ts
// Mock attachmentStorage + db per WidgetService.attachImage.test.ts patterns. Assert:
//  - rejects when attach_image not granted (attach_image_permission_required)
//  - rejects unsupported mime / >5MB (assertWidgetImageFile)
//  - calls requireSafeTicketAndImages BEFORE storeUpload (ordering)
//  - stores BOTH original and a resized image/jpeg derivative (two storeUpload calls)
//  - inserts a widget_chat_images row with messageId === null and returns it
//  - on derivative-store failure, deletes the already-stored original
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd be && pnpm vitest run src/api/services/WidgetService.widgetChatImage.test.ts`
Expected: FAIL — `storeWidgetChatImage` not exported.

- [ ] **Step 4: Implement**

```typescript
// be/src/api/services/WidgetService.ts — near uploadTicketAttachment
import { resizeForModel } from './widgetChatImage';
import { widgetChatImages, type ChatImageRow } from '../../db/schema';

export const MAX_CHAT_IMAGES_PER_MESSAGE = 3;
export const MAX_CHAT_IMAGES_PER_CONVERSATION = 5;

export async function storeWidgetChatImage(
  projectId: string, conversationId: string, widgetUserId: string,
  permissions: Set<string>, file: WidgetUploadFile,
): Promise<ChatImageRow> {
  if (!attachmentsEnabled()) throw new WidgetError('attachments_disabled', 403);
  if (!attachmentStorage.isConfigured()) throw new WidgetError('attachment_storage_unconfigured', 500);
  if (!(await canAttachImages(projectId, permissions))) {
    throw new WidgetError('attach_image_permission_required', 403);
  }
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new WidgetError('project_not_found', 404);
  assertWidgetImageFile(file); // type + size

  // Fail-closed injection screen on the ORIGINAL before anything is stored.
  await requireSafeTicketAndImages(
    { title: 'Widget chat image', description: null },
    [file],
    { agentAssignmentEnabled: project.widgetAgentAssignmentEnabled },
  );

  const derivative = await resizeForModel(file.buffer, file.mimeType);
  const original = await attachmentStorage.storeUpload({
    serverId: project.serverId, body: file.buffer, mimeType: file.mimeType,
    filename: file.filename, originalName: file.originalName ?? file.filename,
    ownerType: 'widget_chat_message',
  });
  let model;
  try {
    model = await attachmentStorage.storeUpload({
      serverId: project.serverId, body: derivative.buffer, mimeType: derivative.mime,
      filename: file.filename.replace(/\.[^.]+$/, '') + '.model.jpg',
      originalName: file.originalName ?? file.filename, ownerType: 'widget_chat_message',
    });
  } catch (err) {
    await attachmentStorage.deleteStoredObject({
      storageProvider: original.storageProvider, storageKey: original.storageKey,
    }).catch(() => {});
    throw err;
  }

  const [row] = await db.insert(widgetChatImages).values({
    conversationId, widgetUserId, messageId: null, serverId: project.serverId,
    mimeType: file.mimeType, originalName: file.originalName ?? null,
    originalStorageProvider: original.storageProvider, originalStorageKey: original.storageKey,
    modelStorageProvider: model.storageProvider, modelStorageKey: model.storageKey,
    width: derivative.width, height: derivative.height,
  }).returning();
  return row!;
}
```
(Confirm `attachmentStorage.storeUpload`'s exact return field names — `{storageProvider, storageKey}` — by reading its definition; adjust if different. `ownerType: 'widget_chat_message'` only needs adding to the storage layer's enum if it constrains the value — check.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd be && pnpm vitest run src/api/services/WidgetService.widgetChatImage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd be && git add src/db/schema.ts drizzle/ src/api/services/WidgetService.ts src/api/services/WidgetService.widgetChatImage.test.ts
git commit -m "feat(widget-chat): widget_chat_images table + storeWidgetChatImage (server-owned refs)"
```

---

## Task 3: Chat-image upload endpoint (be)

**Files:**
- Modify: `be/src/api/HttpServer.ts` (add route near the other `/api/widget/chat/conversations/:id/*` routes, ~line 5990)
- Test: `be/src/api/services/WidgetService.attachImageGate.db.test.ts` (extend) or a new HttpServer route test following existing patterns.

**Interfaces:**
- Consumes: `requireChatUser(c)`, `widgetRateLimit(c, projectId, widgetUserId, 'attachment_upload')`, `WidgetChatService.attachConversationImage`.
- Produces: `POST /api/widget/chat/conversations/:id/images` → `201 { image: PublicChatImage }` where `PublicChatImage = { id, mimeType, originalName, width, height }`. **Storage keys are never returned to the client.**
- Produces: `attachConversationImage(conversationId, projectId, widgetUserId, permissions, file): Promise<PublicChatImage>` (enforces per-conversation cap + conversation writability, then `storeWidgetChatImage`, then maps the row to public fields).

- [ ] **Step 1: Write the failing test**

Assert: 401 when not an identified chat user; 403 without `attach_image`; 400 on missing/oversized/unsupported file; 201 returning `{ image: { id, mimeType, originalName, width, height } }` (and asserting NO `storageKey`/`storageProvider` in the response). Mirror the multipart test style in `WidgetService.attachImageGate.db.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && pnpm vitest run src/api/services/WidgetService.attachImageGate.db.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Implement the route**

```typescript
// be/src/api/HttpServer.ts — after the messages route
app.post('/api/widget/chat/conversations/:id/images', async (c) => {
  const gate = await requireChatUser(c);
  if ('response' in gate) return gate.response;
  const { auth } = gate;
  const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'attachment_upload');
  if (limited) return limited;
  try {
    const formData = await c.req.raw.formData();
    const file = formData.get('file');
    if (!file || typeof (file as any).arrayBuffer !== 'function') {
      return c.json({ error: 'file_required' }, 400);
    }
    const input = file as globalThis.File;
    const buffer = Buffer.from(await input.arrayBuffer());
    const image = await WidgetChatService.attachConversationImage(
      c.req.param('id'), auth.projectId, auth.widgetUserId, auth.permissions,
      { buffer, mimeType: input.type || 'application/octet-stream', filename: input.name || 'image', originalName: input.name },
    );
    return c.json({ image }, 201);
  } catch (err) {
    return widgetErrorResponse(c, err);
  }
});
```

Add the service wrapper that enforces writability + the per-conversation cap, stores, and maps the row to **public fields only**:

```typescript
// be/src/api/services/WidgetChatService.ts
export interface PublicChatImage {
  id: string; mimeType: string; originalName: string | null; width: number; height: number;
}
function toPublicChatImage(row: WidgetService.ChatImageRow): PublicChatImage {
  return { id: row.id, mimeType: row.mimeType, originalName: row.originalName, width: row.width, height: row.height };
}

export async function attachConversationImage(
  conversationId: string, projectId: string, widgetUserId: string,
  permissions: Set<string>, file: WidgetService.WidgetUploadFile,
): Promise<PublicChatImage> {
  await requireWritableConversation(conversationId, projectId, widgetUserId);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(widgetChatImages).where(eq(widgetChatImages.conversationId, conversationId));
  if (Number(count) >= WidgetService.MAX_CHAT_IMAGES_PER_CONVERSATION) {
    throw new WidgetService.WidgetError('attachment_count_exceeded', 400);
  }
  const row = await WidgetService.storeWidgetChatImage(projectId, conversationId, widgetUserId, permissions, file);
  return toPublicChatImage(row);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd be && pnpm vitest run src/api/services/WidgetService.attachImageGate.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd be && git add src/api/HttpServer.ts src/api/services/WidgetChatService.ts src/api/services/WidgetService.attachImageGate.db.test.ts
git commit -m "feat(widget-chat): POST /chat/conversations/:id/images upload endpoint"
```

---

## Task 4: Link images to the sent message + DTO (be)

**Files:**
- Modify: `be/src/api/services/WidgetChatService.ts` (`sendUserMessage` accepts `imageIds`, validates + links)
- Modify: `be/src/api/HttpServer.ts` (messages route forwards `imageIds`; `chatMessageDto` joins images)
- Test: `be/src/api/services/WidgetChatService.images.test.ts`

**Interfaces:**
- Consumes: `widgetChatImages` table, `PublicChatImage`, `toPublicChatImage`.
- Produces: `sendUserMessage(conversationId, projectId, widgetUserId, content, imageIds?: string[])` — validates each id exists in `widget_chat_images` for `(conversationId, widgetUserId)` with `messageId IS NULL`, rejects unknown/foreign ids (`invalid_image_ref`, 400) and >`MAX_CHAT_IMAGES_PER_MESSAGE` (`attachment_count_exceeded`, 400), inserts the message, then `UPDATE widget_chat_images SET message_id = <new msg id> WHERE id IN (...)`. `chatMessageDto` includes `images: PublicChatImage[]` joined from the table by `messageId`.

- [ ] **Step 1: Write the failing test**

Assert: `sendUserMessage` with valid `imageIds` links those rows to the new message (`message_id` set) and they appear in `chatMessageDto.images`; ids from another conversation/user or already-linked ids → 400 (no message inserted); >3 ids → 400; no `imageIds` → unchanged behavior. Mirror `WidgetChatService` test setup.

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && pnpm vitest run src/api/services/WidgetChatService.images.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// be/src/api/services/WidgetChatService.ts — in sendUserMessage, after text validation,
// before/around the message insert:
let linkIds: string[] = [];
if (imageIds && imageIds.length) {
  if (imageIds.length > WidgetService.MAX_CHAT_IMAGES_PER_MESSAGE) {
    throw new WidgetService.WidgetError('attachment_count_exceeded', 400);
  }
  const rows = await db.select({ id: widgetChatImages.id })
    .from(widgetChatImages)
    .where(and(
      inArray(widgetChatImages.id, imageIds),
      eq(widgetChatImages.conversationId, conversationId),
      eq(widgetChatImages.widgetUserId, widgetUserId),
      isNull(widgetChatImages.messageId),
    ));
  if (rows.length !== imageIds.length) throw new WidgetService.WidgetError('invalid_image_ref', 400);
  linkIds = rows.map(r => r.id);
}
// ... existing insert of the message → const message = ...
if (linkIds.length) {
  await db.update(widgetChatImages).set({ messageId: message!.id })
    .where(inArray(widgetChatImages.id, linkIds));
}
```
Messages route: read `body.imageIds` (validate it's a `string[]` if present) and pass to `sendUserMessage`. `chatMessageDto` becomes async OR the caller pre-loads images: add a batched join — load all `widget_chat_images` for the page's message ids and attach `images: PublicChatImage[]` per message (keep it batched, not N+1).

- [ ] **Step 4: Run to verify it passes**

Run: `cd be && pnpm vitest run src/api/services/WidgetChatService.images.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd be && git add src/api/services/WidgetChatService.ts src/api/HttpServer.ts src/api/services/WidgetChatService.images.test.ts
git commit -m "feat(widget-chat): link uploaded images to the sent message (server-validated ids)"
```

---

## Task 5: Transcript carries base64 derivative (be)

**Files:**
- Modify: `be/src/api/services/WidgetChatService.ts` (`buildTranscript`, `dispatchTurn`)
- Test: `be/src/api/services/WidgetChatService.transcript-images.test.ts`

**Interfaces:**
- Produces: transcript user row `{ role: 'user', content: string, images?: { mime: string; dataBase64: string }[] }`. `dispatchTurn` sends it unchanged (it already forwards `transcript: buildTranscript(rows)`).

- [ ] **Step 1: Write the failing test**

Assert: for a user message that has linked `widget_chat_images` rows, the transcript user row's `images[]` carry the **model derivative** (fetched by `modelStorageKey`) base64-encoded; messages with no linked images are unchanged; non-user rows never carry images.

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && pnpm vitest run src/api/services/WidgetChatService.transcript-images.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Make `buildTranscript` async (or add an async post-pass). Batch-load `widget_chat_images` for the conversation's message ids (`WHERE message_id IN (...)`), group by `messageId`. For each user row that has linked images, fetch each `modelStorageKey` via `attachmentStorage.getObjectBuffer({storageProvider, storageKey})` (confirm method name) and attach `images: [{ mime: 'image/jpeg', dataBase64: buf.toString('base64') }]`. Update `dispatchTurn` to `await buildTranscript(rows, conversationId)`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd be && pnpm vitest run src/api/services/WidgetChatService.transcript-images.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd be && git add src/api/services/WidgetChatService.ts src/api/services/WidgetChatService.transcript-images.test.ts
git commit -m "feat(widget-chat): inline base64 model-image derivatives into the turn transcript"
```

---

## Task 6: Extend transcript schema (runhq)

> Implement in a runhq worktree off `origin/master`.

**Files:**
- Modify: `runhq/server/src/http/routes/widget-chat-turn.ts` (`transcriptRowSchema`)
- Modify: `runhq/server/src/services/WidgetChatSessionManager.ts` (`WidgetChatTranscriptRow`)
- Test: `runhq/server/src/http/routes/widget-chat-turn.test.ts` (extend)

**Interfaces:**
- Produces: user transcript row accepts optional `images: { mime: string; dataBase64: string }[]`.

- [ ] **Step 1: Write the failing test**

Add a case to the existing turn route test posting a transcript whose user row includes `images:[{mime:'image/jpeg',dataBase64:'AAAA'}]`; expect 202 (currently 400 — unknown field rejected by zod).

- [ ] **Step 2: Run to verify it fails**

Run: `cd runhq && pnpm vitest run server/src/http/routes/widget-chat-turn.test.ts`
Expected: FAIL (400).

- [ ] **Step 3: Implement**

```typescript
// widget-chat-turn.ts
const chatImageSchema = z.object({ mime: z.string().min(1), dataBase64: z.string().min(1) });
const transcriptRowSchema = z.union([
  z.object({ role: z.enum(['user', 'agent']), content: z.string(), images: z.array(chatImageSchema).optional() }),
  z.object({ role: z.literal('event'), payload: z.record(z.unknown()) }),
]);
```
Mirror the optional `images` field on `WidgetChatTranscriptRow` in `WidgetChatSessionManager.ts` (the `{ role: 'user' | 'agent'; content: string }` member) and thread it through `enqueueTurn`/the request type.

- [ ] **Step 4: Run to verify it passes**

Run: `cd runhq && pnpm vitest run server/src/http/routes/widget-chat-turn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd runhq && git add server/src/http/routes/widget-chat-turn.ts server/src/services/WidgetChatSessionManager.ts server/src/http/routes/widget-chat-turn.test.ts
git commit -m "feat(widget-chat): accept image blocks on the turn transcript"
```

---

## Task 7: Image content blocks + cache breakpoint (runhq)

**Files:**
- Modify: `runhq/server/src/services/WidgetChatSessionManager.ts` (`buildLoopMessages`)
- Test: `runhq/server/src/services/WidgetChatSessionManager.images.test.ts`

**Interfaces:**
- Consumes: extended `WidgetChatTranscriptRow`.
- Produces: user `content` blocks `[{type:'image', source:{type:'base64', media_type, data}}, ..., {type:'text', text}]` with `cache_control:{type:'ephemeral'}` on the last image block.

- [ ] **Step 1: Confirm caching capability**

Run: `cd runhq && grep -rn "cache_control\|replaceMessages\|ContentBlock" server/src/services/WidgetChatSessionManager.ts server/src/<agent-loop-dir>`
Confirm the loop forwards `cache_control` on content blocks and rebuilds a byte-stable prefix each turn. If it strips unknown block fields, add passthrough. Record findings.

- [ ] **Step 2: Write the failing test**

```typescript
// builds image blocks before text, cache_control on the last image
const { history } = buildLoopMessages(
  [{ role: 'user', content: 'see this', images: [{ mime: 'image/jpeg', dataBase64: 'AAAA' }] }],
  null,
);
const userMsg = history.at(-1)!;
const blocks = userMsg.content as any[];
expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
expect(blocks.find(b => b.type === 'image').cache_control).toEqual({ type: 'ephemeral' });
expect(blocks.at(-1)).toMatchObject({ type: 'text', text: 'see this' });
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd runhq && pnpm vitest run server/src/services/WidgetChatSessionManager.images.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `buildLoopMessages`, in the user-row branch (currently `blocks.push({ type:'text', text: row.content })`), prepend image blocks first:

```typescript
const imgs = (row.images ?? []);
imgs.forEach((img, i) => blocks.push({
  type: 'image',
  source: { type: 'base64', media_type: img.mime, data: img.dataBase64 },
  ...(i === imgs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
}));
blocks.push({ type: 'text', text: row.content });
```
Apply the same to the trailing `resumeContent` path so the latest turn's image also caches.

- [ ] **Step 5: Run to verify it passes**

Run: `cd runhq && pnpm vitest run server/src/services/WidgetChatSessionManager.images.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd runhq && git add server/src/services/WidgetChatSessionManager.ts server/src/services/WidgetChatSessionManager.images.test.ts
git commit -m "feat(widget-chat): emit image content blocks with cache breakpoint"
```

---

## Task 8: Widget composer image attach/paste (be)

**Files:**
- Modify: `be/public/widget.js` (`renderChatFooter` ~5506, `doSend` ~5522, `renderChatUserRow` ~4950; reuse `fileToDataUrl` ~469, chat API helpers ~313)
- Test: manual (vanilla JS, no test runner for widget.js).

- [ ] **Step 1: Add upload API helper**

```javascript
function chatUploadImage(conversationId, file) {
  var fd = new FormData();
  fd.append('file', file, file.name || 'image');
  return api('/api/widget/chat/conversations/' + encodeURIComponent(conversationId) + '/images',
    { method: 'POST', body: fd });
}
```

- [ ] **Step 2: Add attach button + paste handler to `renderChatFooter`**

Add an image button beside the send button and a hidden `<input type=file accept="image/*">`; on `paste`, pull `image/*` items from `e.clipboardData.items`. Maintain a `pendingChatImages` array (the `ChatImageRef`s returned by `chatUploadImage`), render thumbnails above the textarea with a remove (×) control, and disable send while an upload is in flight. Enforce `MAX_CHAT_IMAGES_PER_MESSAGE` = 3 client-side. Gate the button on the same `attach_image` config flag the ticket composer uses.

- [ ] **Step 3: Send refs with the message**

In `doSend`, when `pendingChatImages.length`, call `chatSendMessage(convId, content, pendingChatImages)` (extend the helper to append `imageIds`/refs to the JSON body — send the full refs the upload returned, matching Task 4's echo-refs decision). On success, clear `pendingChatImages` and the preview.

- [ ] **Step 4: Render images in the user bubble**

In `renderChatUserRow`, if `row.images?.length`, render an image gallery in the bubble. Reuse the existing lightbox. Images are served via the widget's authenticated image path (same mechanism the ticket detail uses) — confirm the widget's existing image-render helper and reuse it.

- [ ] **Step 5: Manual verification**

Load the widget locally, open chat, paste a screenshot, confirm thumbnail + send, confirm it appears in the bubble and the agent's reply references it.

- [ ] **Step 6: Commit**

```bash
cd be && git add public/widget.js
git commit -m "feat(widget): image attach/paste in support-agent chat composer"
```

---

## Task 9: Carry images onto the created ticket (be)

**Files:**
- Modify: `be/src/api/services/WidgetChatService.ts` (`createTicketFromChat` ~728)
- Test: `be/src/api/services/WidgetChatService.ticketImages.test.ts`

- [ ] **Step 1: Write the failing test**

Assert: when the conversation has linked `widget_chat_images` rows, `createTicketFromChat` attaches the **originals** to the new task as `task` attachments (visible via the ticket's attachment list), deduped by image id.

- [ ] **Step 2: Run to verify it fails**

Run: `cd be && pnpm vitest run src/api/services/WidgetChatService.ticketImages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

After `WidgetService.createTicket(...)` returns `task`, load `widget_chat_images` for the conversation (`WHERE conversation_id = ?`). For each unique row, insert a `workspaceTaskAttachments` row (`ownerType:'task'`, `taskId: task.id`) pointing at the **original** storage key (copy via `attachmentStorage.copyObject` to a task-owned key if owner-keyed paths are required; otherwise reference the existing key). Reuse the storage helper used by `storeTaskAttachment`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd be && pnpm vitest run src/api/services/WidgetChatService.ticketImages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd be && git add src/api/services/WidgetChatService.ts src/api/services/WidgetChatService.ticketImages.test.ts
git commit -m "feat(widget-chat): carry chat images onto the created ticket"
```

---

## Self-Review

**Spec coverage:** §A storage+screening → Tasks 1–2; §B composer → Task 8; §C send+transcript → Tasks 4–5; §D model call → Tasks 6–7; §E ticket carry-over → Task 9. Cost levers: downscale → Task 1; cache breakpoint → Task 7. Security (injection guard, RBAC, caps) → Tasks 2–3. All spec sections mapped.

**Open questions resolved into steps:** caching capability (spec Q1) → Task 7 Step 1 verification; payload-vs-table (Q2) → **dedicated `widget_chat_images` table** (decided with the user; honors the storage-ownership security boundary — client never sees/sends storage keys); per-message cap (Q3) → Global Constraints (3/message, 5/conversation).

**Security:** client receives/sends only the opaque `widget_chat_images.id`; the server validates ids against `(conversationId, widgetUserId)` before linking (Task 4) and never returns storage keys (Task 3 `PublicChatImage`). Matches `HttpServer.ts` storage-ownership rule.

**Signatures to confirm during execution (called out inline, not placeholders):** `attachmentStorage.storeUpload` return fields (Task 2), `attachmentStorage.getObjectBuffer`/`copyObject` method names (Tasks 5, 9), whether the storage `ownerType` is value-constrained for `'widget_chat_message'` (Task 2), `widget_chat_*` id column types for FK alignment (Task 2 Step 1), loop `cache_control` passthrough (Task 7 Step 1). Each is a one-line read, not deferred work.

**Type consistency:** `ChatImageRow` (DB row) defined in Task 2; `PublicChatImage` (safe DTO) in Task 3; images linked by `messageId` in Task 4; base64-inlined from `modelStorageKey` in Task 5; consumed by the runhq transcript shape `{mime, dataBase64}` in Tasks 6–7 — names align across tasks.

---

## Task 10: Serve persisted chat images by id + render history (be) — ADDED post-Task-8

**Why:** the upload endpoint returns only an opaque image id (no URL). Within a session the widget renders from the local FileReader data URL, but after reopen, historical message rows from the server have no data URL and currently show a filename chip. This task adds an authenticated serve-by-id endpoint and wires the widget to render persisted chat images.

**Files:**
- Modify: `be/src/api/HttpServer.ts` (new `GET /api/widget/chat/conversations/:id/images/:imageId`)
- Modify: `be/src/api/services/WidgetChatService.ts` (a resolver that validates ownership + returns a servable form)
- Modify: `be/public/widget.js` (render persisted images by id, replacing the filename-chip fallback)
- Test: `be/src/api/services/WidgetChatService.serveImage.test.ts` (+ route test)

**Interfaces:**
- `GET /api/widget/chat/conversations/:id/images/:imageId` → serves the image (auth: `requireChatUser`; the row's `(conversationId, widgetUserId)` must match the caller). Returns 404 for a foreign/unknown id. Decide serving style by MIRRORING how widget TICKET attachments are served (discover in code): if ticket attachments are served via a presigned `createDownloadUrl`, return `{ url }` (or 302) and let the widget `<img>` it; if they're streamed bytes, stream bytes with the correct `Content-Type` + `Cache-Control: private`. Use the SAME style for consistency. Serve the **original** rendition (`originalStorageProvider`/`originalStorageKey`) for display fidelity.

- [ ] **Step 1: Discover the existing widget image-serve pattern**

Run: `cd be && grep -rn "createDownloadUrl\|attachments/.*:attachmentId\|images/" src/api/HttpServer.ts | head` and read how a widget ticket attachment's displayable URL reaches the widget. Record whether it's presigned-URL or streamed-bytes. The chat-image endpoint MUST mirror it.

- [ ] **Step 2: Write the failing test**

Service/route test: an image id belonging to the caller's conversation resolves (returns the url or bytes); an id from another conversation or another widget user → 404/forbidden; unknown id → 404. RED.

- [ ] **Step 3: Implement the resolver + route**

Resolver in `WidgetChatService.ts`: `resolveConversationImageForServe(conversationId, imageId, projectId, widgetUserId)` → loads the `widget_chat_images` row, asserts `conversationId` + `widgetUserId` match, returns the storage ref (or a presigned url via `attachmentStorage.createDownloadUrl`, matching the discovered style). Route in `HttpServer.ts` gated by `requireChatUser`, mapping not-found/forbidden to 404.

- [ ] **Step 4: Wire the widget (`public/widget.js`)**

In `renderChatUserRow` (and the chip-fallback path from Task 8), when a row has `images` with ids but no local `_dataUrl`, build the image src from the new endpoint (presigned-url style: set `<img src>` to the returned url; bytes style: fetch→blob like the existing authed-image helper) and render the gallery + lightbox instead of the filename chip. Reuse the existing widget image/lightbox helper. `node --check` after.

- [ ] **Step 5: Run tests + commit**

`pnpm vitest run <paths>` GREEN; `node --check public/widget.js`. Commit by explicit pathspec: `feat(widget-chat): serve persisted chat images by id + render in history`.

**Self-review:** ownership enforced (foreign id → 404); serving style matches ticket attachments; original rendition served; widget renders persisted images (no more chip fallback for owned images); no storage keys exposed to the client.
