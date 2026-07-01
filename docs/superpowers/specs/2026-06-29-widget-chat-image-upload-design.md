# Widget Support-Agent Chat — Image Upload (Multimodal)

**Date:** 2026-06-29
**Status:** Approved design → planning
**Repos:** `be` (widget + chat BE) · `runhq` (workspace turn handler / agent loop)

## Problem & Goal

The widget's "Chat with Agent" composer (the Suha support agent) accepts text
only. Visitors filing a bug or request often have a screenshot that is the
clearest description of the issue. **Goal:** let a visitor attach/paste an image
in the chat composer, have the support agent *see* it live (multimodal) when
replying, and carry the image onto any ticket the conversation creates so the
human triager and coding agent get it too.

This is **Option 1 (full multimodal)** from brainstorming: the image reaches the
LLM that powers the chat agent — not just the created ticket.

### Non-goals

- No new model plumbing — the widget chat agent already runs through the same
  vision-capable `createAgentLoop`/`ToolAgentLoop` that powers coder jobs.
- No change to the anonymous-visitor flow — image upload requires an identified
  widget user (same gate as the rest of `/api/widget/chat/*`) plus the existing
  `attach_image` RBAC permission.
- Not reworking the ticket/comment attachment pipeline — we reuse it.

## Background (verified in code)

- Widget UI is hand-written vanilla JS at `be/public/widget.js`. The chat
  composer is `renderChatFooter` (~line 5506); send goes through
  `chatSendMessage` → `POST /api/widget/chat/conversations/:id/messages`
  (`HttpServer.ts` ~5975) → `WidgetChatService.sendUserMessage` (text only).
- Existing image infra is live: `uploadTicketAttachment` / `addWidgetCommentAttachment`
  → injection guard (`requireSafeTicketAndImages`) → `storeTaskAttachment`
  (R2/S3) → `workspaceTaskAttachments` (`ownerType` `task`|`comment`). Gated by
  `attachmentsEnabled()` (default on) + `canAttachImages()` (`attach_image` perm).
  Allowed types: jpeg/png/gif/webp; max 5 MB; max 5/ticket.
- A chat turn is dispatched BE→workspace via HMAC `POST /api/internal/widget-chat/turn`
  (`WidgetChatService.dispatchTurn`). The transcript is rebuilt from Postgres
  **every turn** and is currently text-only: `transcriptRowSchema` =
  `{role:'user'|'agent', content:string} | {role:'event', payload}`.
- Workspace side (`runhq`): `widget-chat-turn.ts` validates the transcript and
  calls `WidgetChatSessionManager.enqueueTurn`. `buildLoopMessages` maps user
  rows to Anthropic **content blocks** (`[{type:'text', text}]`) and runs
  `loop.replaceMessages(history)` + `loop.resume(resumeContent)` on a disposable
  `createAgentLoop`. Adding `{type:'image', source}` blocks is a supported,
  additive change.

## Cost strategy (the crux of Option 1)

Two levers, both grounded in the Claude API vision + prompt-caching docs:

1. **Downscale before the model sees it.** Vision billing scales with pixel
   area. Targets on Opus 4.8 ($5/1M input): full-res ≈4,800 tok ≈ $0.024;
   1080p ≈2,500 tok; **1024px long edge ≈1,000 tok ≈ $0.005**. A support
   screenshot only needs UI-text legibility → **resize the model-facing copy to
   ≤1024px long edge, re-encode (JPEG/WebP), strip EXIF.** Keep the original for
   the human/ticket.
2. **Prompt-cache the image.** BE rebuilds the full transcript each turn, so an
   image attached at turn 2 would be re-sent at turns 3,4,5… Place a
   `cache_control` breakpoint right after the image block → re-sends bill at
   ~0.1×. First send ≈$0.005, each later turn ≈$0.0005. Net: **< 1¢ for a whole
   conversation.**

Supporting caps: reuse the 5-image / 5 MB limits; the fail-closed injection
guard already screens widget images (no new cost, and it is the safety gate
that makes feeding visitor images to the agent acceptable).

## Architecture

### A. Storage & screening (`be`)

- New attachment owner type `widget_chat_message` (no ticket exists yet at chat
  time). Reuse `storeTaskAttachment` + `requireSafeTicketAndImages`.
- On upload, produce **two renditions**: the **original** (kept, used for the
  ticket / human) and a **model-optimized derivative** (≤1024px long edge,
  JPEG/WebP, EXIF stripped) via `sharp`.
- Persist refs on the chat message `payload` (e.g. `payload.images: [{ id,
  originalKey, modelKey, mime, w, h }]`). No new table needed if `payload`
  (jsonb) suffices; add `widget_chat_message_attachments` only if we need
  independent lifecycle/GC.

### B. Widget composer (`be/public/widget.js`)

- Add an attach-image button + paste-to-upload to `renderChatFooter`, reusing
  `fileToDataUrl` and the existing upload helpers' patterns. Thumbnail preview
  above the textarea; render images inside the user's chat bubble
  (`renderChatUserRow`). Gate the affordance on `attach_image` (config flag the
  bootstrap already carries for tickets).
- New endpoint: `POST /api/widget/chat/conversations/:id/images` (multipart),
  mirroring the ticket-attachment route's auth + rate-limit + RBAC, returning
  the stored image ref. The composer uploads first, then includes the returned
  ref id(s) when it sends the message.

### C. Message send + transcript (`be`)

- `sendUserMessage` accepts optional `imageIds`, validates ownership, attaches
  them to the message `payload`, and includes them when present.
- Extend the turn `transcriptRowSchema` user row to optionally carry images:
  `{role:'user', content:string, images?: [{ mime, dataBase64 }]}`. `buildTranscript`
  inlines the **base64 of the downscaled derivative** (chosen over signed-URL
  fetch: simpler, no workspace egress/auth, and caching neutralizes the
  re-send cost). `chatMessageDto` also surfaces image refs so the widget renders
  them on reload.

### D. Model call (`runhq`)

- Extend `transcriptRowSchema` (workspace side) to accept the `images` field.
- In `buildLoopMessages`, prepend `{type:'image', source:{type:'base64',
  media_type, data}}` blocks before the text block in the user message, and set
  a `cache_control` breakpoint after the image block. **Implementation check:**
  confirm `createAgentLoop`/`ToolAgentLoop` keeps the rebuilt prefix byte-stable
  across turns and exposes a way to set the breakpoint; if it doesn't cache
  today, add it (small, isolated).

### E. Onto the ticket (`be`)

- When the conversation creates a ticket (`createTicketFromChat`), carry the
  **original** images over as `task` attachments so the coding agent (already
  multimodal on task attachments) and human triager receive them.

## Data flow

```
visitor paste/attach
  → POST /chat/.../images (multipart)  ── injection guard ─→ store original + ≤1024 derivative
  → POST /chat/.../messages {content, imageIds}
  → sendUserMessage: attach refs to message.payload, dispatchTurn
  → buildTranscript: user row carries base64(derivative)
  → POST /api/internal/widget-chat/turn  (HMAC)
  → WidgetChatSessionManager.buildLoopMessages: image blocks + cache breakpoint
  → vision model replies
  ...
  → createTicketFromChat: original images → task attachments
```

## Security

- Identified widget user required (existing chat gate) + `attach_image` RBAC.
- Fail-closed injection guard screens every image before storage/derivative —
  unchanged behavior, applied to chat images too.
- SVG excluded (existing allowlist). 5 MB / 5-image caps. Rate-limited via the
  existing `attachment_upload` bucket.

## Testing

- `be`: unit tests for the new upload endpoint (auth/RBAC/guard/caps), the
  derivative generation (dimensions/mime/EXIF), `sendUserMessage` image
  attachment, `buildTranscript` base64 inlining, and ticket carry-over.
- `runhq`: unit tests for the extended `transcriptRowSchema` and
  `buildLoopMessages` image-block + cache-breakpoint construction.
- E2E sanity: attach a screenshot in the widget, confirm the agent references
  its contents in the reply, and that a created ticket shows the image.

## Rollout

- BE: feature branch → PR → deploy (per be deploy runbook). Client widget.js
  ships with the BE.
- runhq: workspace-server change → image rebuild or staging hotfix per runbook.
- Both sides must be deployed before the feature is enabled end to end; the
  transcript `images` field is additive and backward-compatible (older
  workspace ignores it; older BE never sends it).

## Open questions / verify during implementation

1. Does `createAgentLoop` already prompt-cache, and can we set a breakpoint
   after the image block? (Section D.)
2. `payload.images` on the message vs. a dedicated attachments table — decide by
   whether independent GC/lifecycle is needed.
3. Max images per chat message (propose 3) vs. per conversation (reuse 5).
