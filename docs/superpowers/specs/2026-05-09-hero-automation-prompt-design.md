# Hero: "What do you want to automate?" prompt input

**Date:** 2026-05-09
**Status:** Approved, ready for implementation plan
**Scope:** `src/components/Hero.tsx` only

## Goal

Replace the homepage hero's static tagline + CTA with a Replit-style prompt input that captures the visitor's automation intent and forwards it through the signup flow.

## Why

The current hero ("Watch your app build itself" + "Get Started" button) tells visitors what RunHQ does. The new hero asks what they want to do. That intent — captured as free text and passed to signup — gives the post-auth product a starting context, and gives the homepage a more engaging entry point.

This is a faithful adaptation of Replit's homepage pattern (`What will you build?` + textarea + chips), reframed for automation.

## Non-goals

- No backend/API. Submission is a client-side redirect.
- No changes to the signup page itself. The signup page at `app.runhq.io/signup` is responsible for reading `?prompt=` and doing whatever it wants with it.
- No analytics wiring beyond what already exists in the file (none currently).
- No changes to the WebGL canvas, topbar, or rest of the homepage.

## User-facing behavior

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  • RunHQ                                          Sign in    │
│                                                              │
│                                                              │
│              What do you want to automate?                   │
│                                                              │
│   ┌────────────────────────────────────────────────────┐    │
│   │ Describe a workflow…                               │    │
│   │                                                    │    │
│   │                                              [ → ] │    │
│   └────────────────────────────────────────────────────┘    │
│                                                              │
│   [Triage support tickets]  [Sync Stripe → Notion]           │
│        [Daily standup digest]  [Auto-tag GitHub issues]      │
│                                                              │
│                                                              │
│                  (animated WebGL background)                 │
└──────────────────────────────────────────────────────────────┘
```

### Copy

- **Headline:** `What do you want to automate?`
  - Replaces the existing `Watch your app build itself` tagline.
  - Reuses the existing `.rh-tagline` typography (gradient `<em>` styling no longer needed; can be plain).
- **Sub-tagline:** removed entirely. The textarea is the message.
- **Textarea placeholder:** `Describe a workflow…`
- **Suggestion chips (4):**
  1. Triage support tickets
  2. Sync Stripe to Notion
  3. Daily standup digest
  4. Auto-tag GitHub issues

### Interactions

| Action | Behavior |
|---|---|
| Type in textarea | Stored in component state. Submit button enabled when text is non-empty (after `.trim()`). |
| Press Enter | Submit (if non-empty). |
| Press Shift+Enter | Insert newline. Do not submit. |
| Click submit arrow | Submit (if non-empty). |
| Click chip | Pre-fill textarea with chip text and focus the textarea. **Do not auto-submit.** |
| Submit empty | No-op. Button is disabled with reduced opacity. |
| Submit non-empty | `window.location.href = https://app.runhq.io/signup?prompt=<encodeURIComponent(text.trim())>` |

### Edge cases

- **Long input:** Soft cap of 500 characters via `maxLength` on the textarea. Past that, typing is blocked by the browser. No truncation logic needed.
- **Reduced motion:** Submit button has no shimmer/pulse animations. Hover transitions stay (they're transform/color only and respect motion reasonably).
- **No JavaScript / WebGL fail:** Textarea and submit still work — they don't depend on the canvas. Existing fallback already leaves the dark background.
- **Mobile (≤700px):** Textarea is full width within `.rh-copy` padding. Chips wrap to multiple lines. Submit arrow stays inside the textarea (bottom-right). No autofocus, so the keyboard doesn't pop up on page load.

## Technical design

### Files touched

- `src/components/Hero.tsx` — the only file edited.

### Component changes

Inside `Hero()`:

- Add `const [prompt, setPrompt] = useState('')`.
- Add a `handleSubmit()` function:

  ```ts
  function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    window.location.href = `${SIGNUP_URL}?prompt=${encodeURIComponent(trimmed)}`;
  }
  ```

- Add a `handleKeyDown()` for the textarea: Enter (no Shift) → `e.preventDefault(); handleSubmit()`.
- Add a `chips` constant (plain array of 4 strings).
- Replace the contents of `.rh-copy` (the `<h1>`, `<p>`, `.rh-ctas` block) with:
  - `<h1 className="rh-tagline">What do you want to automate?</h1>` (no `<em>` gradient)
  - A `<form>` (or just a `<div>`) wrapping the textarea + submit-arrow button
  - A row of chip `<button>`s

### CSS additions to `HERO_STYLES`

New rules (no removals beyond what becomes unused — `.rh-sub`, `.rh-ctas`, `.rh-btn-primary`, `.rh-btn-ghost` can be deleted along with `.rh-tagline em`):

- `.rh-prompt-form` — container, max-width ~720px, full width on mobile.
- `.rh-prompt-input` — textarea: rounded (~14–16px radius), translucent dark background with backdrop-filter blur, ~3 lines visible by default (`rows={3}`), no resize handle, padding leaves room for the submit button bottom-right. Border uses `var(--line)`; focus border uses `var(--accent)`.
- `.rh-prompt-submit` — absolutely positioned bottom-right inside `.rh-prompt-form`, circular ~36px, accent gradient like the current `.rh-btn-primary`. Disabled state: `opacity: 0.4; cursor: not-allowed`.
- `.rh-chips` — flex row, wraps, gap ~10px, margin-top ~16px.
- `.rh-chip` — pill button, translucent dark background + border like `.rh-btn-sign`, hover lifts to accent border/text.

Mobile breakpoint (`@media (max-width: 700px)`) adjusts padding and font sizes; chips wrap automatically.

### Removed code

- `SIGNUP_URL`-using `<a className="rh-btn rh-btn-primary">` button.
- `.rh-sub` paragraph.
- The gradient `<em>` styling on `.rh-tagline em` (no longer used).
- CSS rules: `.rh-sub`, `.rh-ctas`, `.rh-btn`, `.rh-btn-primary`, `.rh-btn-ghost`, `.rh-tagline em`.

`SIGNUP_URL` constant stays — used by the new submit handler. `LOGIN_URL` stays — used by the topbar Sign in link.

## Testing

Manual browser testing only (matches existing repo conventions — no test files exist for `Hero.tsx`):

1. Type text → submit button enables → Enter sends to `/signup?prompt=...`.
2. Shift+Enter inserts newline, doesn't submit.
3. Click each chip → textarea pre-fills, focuses, button enables. No auto-submit.
4. Click submit arrow with empty text → nothing happens.
5. Resize to mobile width → layout reflows, chips wrap, no horizontal scroll.
6. `prefers-reduced-motion: reduce` → no submit-button animations; canvas pauses as it does today.
7. Verify the `?prompt=` value lands at the signup URL with proper URL encoding (e.g. spaces, `→`, quotes).

## Out of scope / future

- Inline-suggested completions, history of recent prompts, server-side capture of submissions — none of these are part of this change.
- Per-chip iconography. Could add later if the chips feel too plain.
- A/B testing the headline copy. Possible later; not blocking.
