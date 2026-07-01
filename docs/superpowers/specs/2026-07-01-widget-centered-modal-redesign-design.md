# Widget Centered-Modal Redesign

**Date:** 2026-07-01
**Status:** Approved — ready for implementation planning
**Scope:** `public/widget.js` (embeddable vanilla-JS widget) only. No backend, API, or schema changes.

## Problem

The embeddable widget opens some screens as a small 400px panel anchored to the
bottom corner (Intercom-style), which feels cramped. We want the widget to open
as a large centered modal for every screen, and we want the discussion board's
`[+New Post]` action to launch the agent chat (a guided, conversational way to
file a ticket) instead of the bare title/description form.

## Current State

The widget's opened panel has two geometries, toggled by a single `rw-compact`
CSS class on the scrim element:

- **Compact corner panel** (`400px`, anchored 20px from the corner, scrim does
  not capture page clicks) — used for views `home`, `chat`, `compose`.
- **Large centered modal** (`min(720px, …) × min(680px, …)`, centered, full
  scrim overlay) — used for views `list` and `detail`.

Key code (`public/widget.js`):

- `isCompactView(v)` — returns `true` for `home`/`chat`/`compose`.
- `applyShellMode()` — toggles `widgetEl.classList` `rw-compact` from
  `isCompactView(view)`.
- CSS: `.rw-shell` (centered geometry), the `.rw-shell-scrim.rw-compact …`
  block (corner geometry + scrim pass-through), and a mobile `@media
  (max-width: 640px)` rule that fullscreens `.rw-shell` in both modes.
- `renderTabBar()` builds `rw-new-post-btn`; its click handler is `goCompose`.
- `goCompose()` / `renderInlineComposer()` — the direct compose form.
- `openChat()` — opens `view = "chat"`; the chat back button (in
  `renderChatViewShell`) returns to `home` for the normal (non-live) case.

## Requirements

1. Clicking the launcher opens a **large centered modal** for every screen
   (`home`, `chat`, `list`, `updates`, `detail`). The small bottom-corner panel
   mode is removed entirely.
2. The discussion board's `[+New Post]` button launches the **agent chat**
   (`openChat`) instead of the direct compose form.
3. The agent chat renders inside that same large centered modal.
4. The direct compose form is retired from active use but its code is kept in
   place for possible future re-use (not deleted, not wired to any control).

## Design

All edits are in `public/widget.js`.

### Change 1 — Single centered modal for all views

- `isCompactView(v)` no longer classifies any view as compact. The corner mode
  is gone, so `applyShellMode()` never adds `rw-compact`; every view uses the
  `.rw-shell` centered geometry over the full scrim overlay that `list`/`detail`
  already use.
- Delete the now-dead `.rw-shell-scrim.rw-compact …` CSS block (corner geometry
  + `pointer-events: none` scrim pass-through + its open/animation variants).
- Fold the mobile `@media (max-width: 640px)` fullscreen rule so it targets
  plain `.rw-shell` (drop the `.rw-shell-scrim.rw-compact .rw-shell` selector
  half, which no longer exists).
- Update the explanatory comment above `isCompactView` to describe the single
  centered-modal model.

The launcher pill (`rw-tab`) is unchanged — it remains an edge tab. Only the
opened panel changes geometry.

### Change 2 — `[+New Post]` opens the agent chat

- In `renderTabBar()`, change `newPostBtn`'s click handler from `goCompose` to
  `openChat`.
- Add return-view bookkeeping for chat, mirroring the existing
  `composeReturnView` pattern:
  - Introduce a `chatReturnView` variable (default `"home"`).
  - `openChat()` records where it was launched from:
    `chatReturnView = view === "list" ? "list" : "home"`. This must be set
    before `view` is reassigned to `"chat"`.
  - In `renderChatViewShell()`, the normal (non-live) back handler returns to
    `chatReturnView` (via `goList(...)` when it was `"list"`, else `goHome()`)
    instead of unconditionally calling `goHome()`.
  - Live-session (`chatIsLiveSession`) and detail-spawned chats keep their
    existing back targets — this change only affects the normal chat path.

Rationale: the agent chat already creates a ticket in both agent mode (proposal
flow) and agentless intake mode ("Submit Ticket" action), and already supports
image attachments (`pendingChatImages`), so redirecting `[+New Post]` to it
loses no capability.

### Change 3 — Retire but keep the compose form

- `goCompose()` and `renderInlineComposer()` stay defined and unchanged, but are
  no longer wired to any control (nothing calls `goCompose` after Change 2).
  `composeReturnView` and the `compose` view branch in `renderPanelBody()` stay
  in place. No deletion.

## Non-Goals

- No launcher-pill repositioning or restyle.
- No changes to ticket-creation semantics, chat transport, or image attachments.
- No i18n / copy changes.
- No backend, API route, or database changes.

## Testing / Verification

- Load the widget locally; click the launcher — the panel opens centered over a
  full scrim (not in the bottom corner) on the home screen.
- From home, open the agent chat — it renders in the centered modal; back
  returns to home.
- Open Join Open Discussion → click `[+New Post]` — the agent chat opens in the
  centered modal; back returns to the discussion list (not home).
- Verify agent mode and agentless intake mode both still reach ticket creation.
- Mobile viewport (≤640px): the modal is fullscreen for all views.
- Confirm no `rw-compact` class is ever added to the scrim during navigation.

## Follow-up — land directly on the discussion board

After review, the "Hi 👋 How can we help?" home menu proved redundant: its three
cards all map to the discussion list view (Chat with Agent → `[+ New post]`,
Join Open Discussion → Hot tab, View Latest Updates → Updates tab). So the
widget now opens **directly on the discussion board (Hot tab)** and the home
menu is retired from the flow.

Changes (all in `public/widget.js`):

- Default landing view is `list` on the `hot` tab — both the initial `view` /
  `activeTab` and the `closePanel` reset (which controls the next open).
- The list view's slim topbar swaps its back-to-home button for the board title
  (`header.feedback` → "{name} Feedback", falling back to the greeting when the
  project name has not loaded). The topbar stays so its right padding keeps the
  title clear of the absolute-positioned shell actions.
- Chat back-navigation returns to the discussion board in every normal case
  (`[+ New post]` is the only entry point), so the `chatReturnView` bookkeeping
  added above is removed and the chat back handler calls `goList()`.
- `renderHomeView` / `renderHomeCard` / `goHome` stay defined but unwired — no
  navigation path lands on `home` anymore — kept for possible re-use.

Verification delta: clicking the launcher opens the discussion board (Hot tab)
titled "{name} Feedback"; `[+ New post]` opens the agent chat and its back
returns to the board; no normal navigation reaches the old home menu.

## Follow-up — ticket-detail stepper reflects the new lifecycle

The ticket-detail progress stepper collapsed the new lifecycle statuses
(`done`/`reviewed`/`merged` → one "In review" step, `deployed` → "Shipped"),
so it didn't reflect `reviewed`, `merged`, or the deploy environment. The
stepper is derived server-side in `src/api/services/ticketMilestones.ts` (the
widget renders whatever milestone array it receives — code-safe), so the fix is
there, not in `widget.js`.

New track (mirrors the runhq lifecycle; `Clarifying` still appears only when a
clarification session exists):

`Received → Clarifying → In progress → In review → Reviewed → Merged → Deployed`

Status → step: `pending`/`planned` → Received; `in_progress` → In progress;
`done` → In review; `reviewed` → Reviewed; `merged` → Merged; `deployed` /
`deployed:<env>` → Deployed (whole track complete); `cancelled` → `Received` +
a terminal `Cancelled` step. A merged PR advances to Merged; an open PR to In
review (status stays authoritative via `max()` across signals).

The deploy step resolves `deployed:<envId>` to **"Deployed → <name>"** using the
project's `deploy_environments` id→name map (synced from the workspace
heartbeat, already carried on the ticket-detail response as `environments`).
Falls back to a bare "Deployed" for legacy `deployed`, unknown envs, no map, or
an upcoming (not-yet-deployed) step — the raw env id is never shown.

Note: this required rebasing the branch onto `origin/master`, which had shipped
the env-name resolution (`widget_projects.deploy_environments` + the
`environments` field on bootstrap/detail responses) that the original task
branch predated.
