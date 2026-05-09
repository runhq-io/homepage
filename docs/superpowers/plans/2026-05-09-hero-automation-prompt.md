# Hero Automation Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the homepage hero's static tagline + "Get Started" button with a Replit-style prompt input that captures automation intent and forwards it to `app.runhq.io/signup?prompt=...`.

**Architecture:** Single-file change to `src/components/Hero.tsx`. Add a controlled textarea + circular submit button + suggestion chip row inside the existing `.rh-copy` container. WebGL canvas, topbar, and signup-page integration are untouched. State is local React state; submission is a `window.location.href` redirect.

**Tech Stack:** React 18 + TypeScript, plain CSS-in-JS string template (matching existing pattern), Vite build, no new dependencies.

**Note on testing:** This codebase has Vitest configured but **zero existing component tests** and no jsdom/RTL setup. Adding the first component test purely for this change is overkill. Per the spec, testing is `tsc`/`vite build` for compile correctness + a manual browser smoke checklist. This is intentional.

---

## File Structure

Only file touched:

- **Modify** `src/components/Hero.tsx` — add state/handlers, replace `.rh-copy` JSX, update `HERO_STYLES` (add new rules, remove unused).

No new files.

---

## Task 1: Replace `.rh-copy` JSX with prompt input + chips

**Files:**
- Modify: `src/components/Hero.tsx` (imports, component body, JSX)

- [ ] **Step 1: Update imports**

Open `src/components/Hero.tsx`. Replace line 1:

```tsx
import { useEffect, useRef } from 'react';
```

with:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
```

- [ ] **Step 2: Add the chip prompt list constant**

Below the existing `LOGIN_URL` constant (currently line 4), add:

```tsx
const CHIP_PROMPTS = [
  'Triage support tickets',
  'Sync Stripe to Notion',
  'Daily standup digest',
  'Auto-tag GitHub issues',
];
```

So that block now reads:

```tsx
const SIGNUP_URL = 'https://app.runhq.io/signup';
const LOGIN_URL = 'https://app.runhq.io';

const CHIP_PROMPTS = [
  'Triage support tickets',
  'Sync Stripe to Notion',
  'Daily standup digest',
  'Auto-tag GitHub issues',
];
```

- [ ] **Step 3: Add state, ref, and handlers inside `Hero()`**

Inside the `Hero` component, immediately after the existing two refs (currently `heroRef` and `canvasRef` near line 109–110), add:

```tsx
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');

  function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    window.location.href = `${SIGNUP_URL}?prompt=${encodeURIComponent(trimmed)}`;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleChipClick(text: string) {
    setPrompt(text);
    textareaRef.current?.focus();
  }
```

So the top of the component reads:

```tsx
export default function Hero() {
  const heroRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');

  function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    window.location.href = `${SIGNUP_URL}?prompt=${encodeURIComponent(trimmed)}`;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleChipClick(text: string) {
    setPrompt(text);
    textareaRef.current?.focus();
  }

  useEffect(() => {
    // ... existing useEffect body unchanged ...
```

The existing `useEffect` body stays exactly as it is.

- [ ] **Step 4: Replace the `.rh-copy` JSX**

Find the existing block (currently lines 240–250):

```tsx
      <div className="rh-copy">
        <h1 className="rh-tagline">Watch your app <em>build itself</em></h1>
        <p className="rh-sub">
          RunHQ collects user feedback, AI agents build from it, and <strong>you decide what ships.</strong>
        </p>
        <div className="rh-ctas">
          <a className="rh-btn rh-btn-primary" href={SIGNUP_URL}>
            Get Started
          </a>
        </div>
      </div>
```

Replace it with:

```tsx
      <div className="rh-copy">
        <h1 className="rh-tagline">What do you want to automate?</h1>
        <div className="rh-prompt-form">
          <textarea
            ref={textareaRef}
            className="rh-prompt-input"
            placeholder="Describe a workflow…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            maxLength={500}
          />
          <button
            type="button"
            className="rh-prompt-submit"
            onClick={handleSubmit}
            disabled={!prompt.trim()}
            aria-label="Submit"
          >
            →
          </button>
        </div>
        <div className="rh-chips">
          {CHIP_PROMPTS.map((text) => (
            <button
              key={text}
              type="button"
              className="rh-chip"
              onClick={() => handleChipClick(text)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
```

- [ ] **Step 5: Verify it compiles**

Run:

```bash
cd /app/data/home/homepage && npx tsc --noEmit
```

Expected: no output, exit code 0. (TypeScript may flag missing CSS classes as warnings — those don't surface in `tsc` since they're string literals; ignore. If `tsc` errors on missing `useState` or `KeyboardEvent` imports, recheck Step 1.)

- [ ] **Step 6: Commit (do not run yet — wait for Task 2 so the visible state is consistent)**

Don't commit yet. The page will render with default browser textarea/button styling at this point, which is ugly. Roll the styling change in Task 2 into the same commit. **Skip to Task 2.**

---

## Task 2: Update CSS — add new rules, remove unused

**Files:**
- Modify: `src/components/Hero.tsx` (the `HERO_STYLES` template literal at the bottom)

- [ ] **Step 1: Remove the gradient `<em>` rule from `.rh-tagline`**

Inside `HERO_STYLES`, find:

```css
  .rh-tagline em {
    font-style: normal;
    background: linear-gradient(100deg,
      oklch(0.96 0.14 180) 0%,
      oklch(0.88 0.22 160) 45%,
      oklch(0.85 0.22 130) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
```

Delete the entire rule (the headline no longer has an `<em>` child).

- [ ] **Step 2: Remove the `.rh-sub` rules**

Find and delete:

```css
  .rh-sub {
    font-size: clamp(17px, 1.35vw, 20px);
    line-height: 1.55;
    color: oklch(0.92 0.01 240);
    max-width: 640px;
    margin: 0 auto 32px;
    text-wrap: pretty;
    text-shadow: 0 1px 12px rgba(0, 0, 0, 0.55);
  }
  .rh-sub strong { color: var(--ink); font-weight: 500; }
```

- [ ] **Step 3: Remove the `.rh-ctas` and `.rh-btn-*` rules**

Find and delete this entire block:

```css
  .rh-ctas { display: inline-flex; gap: 12px; align-items: center; }
  .rh-btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 14px 22px;
    font-family: inherit;
    font-size: 14px; font-weight: 500;
    border-radius: 10px;
    text-decoration: none; cursor: pointer;
    transition: transform .18s, background .2s, border-color .2s;
  }
  .rh-btn-primary {
    background: linear-gradient(180deg, oklch(0.93 0.17 180), oklch(0.78 0.2 180));
    color: #061014;
    border: 1px solid oklch(0.86 0.18 180);
    box-shadow:
      0 0 0 1px oklch(0.86 0.19 180 / 0.25),
      0 12px 44px -10px oklch(0.86 0.19 180 / 0.55),
      inset 0 1px 0 rgba(255,255,255,0.35);
  }
  .rh-btn-primary:hover { transform: translateY(-1px); }
  .rh-btn-ghost {
    background: rgba(12,14,18,0.55); color: var(--ink);
    border: 1px solid var(--line); backdrop-filter: blur(10px);
  }
  .rh-btn-ghost:hover { border-color: var(--accent); color: var(--accent); }
```

- [ ] **Step 4: Add new prompt-form, submit, and chip rules**

Insert this block immediately before the existing `@media (max-width: 700px)` rule near the bottom of `HERO_STYLES`:

```css
  /* Prompt input */
  .rh-prompt-form {
    position: relative;
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
  }
  .rh-prompt-input {
    width: 100%;
    min-height: 120px;
    padding: 18px 20px 56px;
    font-family: inherit;
    font-size: 16px;
    line-height: 1.5;
    color: var(--ink);
    background: rgba(10, 12, 16, 0.65);
    border: 1px solid var(--line);
    border-radius: 16px;
    resize: none;
    outline: none;
    backdrop-filter: blur(14px);
    transition: border-color 0.18s, box-shadow 0.18s;
  }
  .rh-prompt-input::placeholder { color: var(--ink-faint); }
  .rh-prompt-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px oklch(0.86 0.19 180 / 0.18);
  }
  .rh-prompt-submit {
    position: absolute;
    right: 12px;
    bottom: 12px;
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 600;
    line-height: 1;
    color: #061014;
    background: linear-gradient(180deg, oklch(0.93 0.17 180), oklch(0.78 0.2 180));
    border: 1px solid oklch(0.86 0.18 180);
    border-radius: 50%;
    cursor: pointer;
    box-shadow:
      0 0 0 1px oklch(0.86 0.19 180 / 0.25),
      0 8px 24px -8px oklch(0.86 0.19 180 / 0.55),
      inset 0 1px 0 rgba(255,255,255,0.35);
    transition: transform 0.18s, opacity 0.18s;
  }
  .rh-prompt-submit:hover:not(:disabled) { transform: translateY(-1px); }
  .rh-prompt-submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Suggestion chips */
  .rh-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    margin-top: 18px;
    max-width: 720px;
  }
  .rh-chip {
    font-family: inherit;
    font-size: 13px;
    color: var(--ink);
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(10, 12, 16, 0.55);
    backdrop-filter: blur(10px);
    cursor: pointer;
    transition: border-color 0.18s, color 0.18s;
  }
  .rh-chip:hover { border-color: var(--accent); color: var(--accent); }
```

- [ ] **Step 5: Update the mobile media query**

Find:

```css
  @media (max-width: 700px) {
    .rh-hero { min-height: 560px; }
    .rh-copy { padding: 80px 22px 72px; }
    .rh-tagline { margin-bottom: 18px; }
    .rh-sub { margin-bottom: 22px; }
  }
```

Replace with:

```css
  @media (max-width: 700px) {
    .rh-hero { min-height: 560px; }
    .rh-copy { padding: 80px 22px 72px; }
    .rh-tagline { margin-bottom: 18px; }
    .rh-prompt-input { min-height: 110px; }
    .rh-chip { font-size: 12px; padding: 7px 12px; }
  }
```

- [ ] **Step 6: Verify it still compiles**

Run:

```bash
cd /app/data/home/homepage && npx tsc --noEmit
```

Expected: no output, exit code 0.

- [ ] **Step 7: Run the production build**

Run:

```bash
cd /app/data/home/homepage && npm run build
```

Expected: build succeeds, `dist/` is produced. No errors. Warnings about chunk size for `three` are pre-existing and fine.

- [ ] **Step 8: Commit**

```bash
cd /app/data/home/homepage && git add src/components/Hero.tsx && git commit -m "$(cat <<'EOF'
Replace hero tagline with automation prompt input

Adopt a Replit-style prompt UI on the homepage hero: headline reads
"What do you want to automate?", a textarea + circular submit button
captures the visitor's intent, and four suggestion chips pre-fill the
textarea. Submission redirects to app.runhq.io/signup?prompt=<encoded>.
Drops the previous static sub-tagline and "Get Started" CTA, along
with the now-unused .rh-sub / .rh-btn-* CSS rules.

EOF
)"
```

---

## Task 3: Manual browser smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Start the dev server**

Run:

```bash
cd /app/data/home/homepage && npm run dev
```

Expected: Vite prints a local URL (typically `http://localhost:5173`).

- [ ] **Step 2: Open the homepage and verify visual baseline**

Open the dev URL in a browser. Confirm:

- The animated WebGL background renders (the "creature field" colors pulse).
- Topbar shows `• RunHQ` on the left, `Sign in` on the right.
- Headline reads exactly: `What do you want to automate?`
- Below the headline: a rounded translucent textarea with placeholder `Describe a workflow…`.
- A circular accent-colored submit button (`→`) is anchored to the bottom-right of the textarea, currently dimmed (disabled).
- Below the textarea: four chip buttons in a row that wrap on narrow viewports.

If any of these are missing or the layout is broken, return to Tasks 1–2 and inspect the diff.

- [ ] **Step 3: Verify typing + Enter submission**

In the textarea, type `Send a Slack ping when a Linear ticket is set to urgent`. Confirm:

- Submit arrow becomes fully opaque (enabled) as soon as text is non-empty.
- Press **Enter** — the page navigates to a URL ending in:
  `/signup?prompt=Send%20a%20Slack%20ping%20when%20a%20Linear%20ticket%20is%20set%20to%20urgent`
- The browser address bar should show the full URL (the destination domain is `app.runhq.io`, which is fine — verify the encoded `prompt` parameter is correct).

Hit the back button. The hero should restore (state will be empty — that's expected, no persistence is required).

- [ ] **Step 4: Verify Shift+Enter inserts newline**

In the textarea, type `line one`, press **Shift+Enter**, type `line two`. Confirm:

- A new line is inserted; the page does NOT navigate.
- The textarea grows or scrolls to fit; submit stays enabled.

Clear the textarea.

- [ ] **Step 5: Verify chips pre-fill and focus**

Click the chip `Triage support tickets`. Confirm:

- The textarea is populated with exactly `Triage support tickets`.
- The textarea receives focus (cursor visible at end of text).
- Submit arrow is enabled.
- The page does NOT navigate (no auto-submit).

Click another chip — its text replaces the textarea contents (overwrites, doesn't append). This is expected.

- [ ] **Step 6: Verify empty submit is a no-op**

Clear the textarea. Try to click the submit arrow. Confirm:

- Cursor is `not-allowed` on hover.
- Click does nothing — no navigation.

Type only spaces (`   `). Confirm submit stays disabled (we trim before checking).

- [ ] **Step 7: Verify mobile layout**

Open browser DevTools, switch to a narrow viewport (e.g. iPhone SE, ~375px wide). Confirm:

- No horizontal scroll.
- Headline reflows; textarea is full-width within the page padding.
- Chips wrap to multiple lines as needed.
- Tapping the textarea on mobile (or simulator) brings up the keyboard but only after tap — page load does NOT autofocus the textarea (no unwanted scroll/keyboard popup).

- [ ] **Step 8: Verify `prefers-reduced-motion`**

In Chrome DevTools: open the rendering tab (three-dot menu → More tools → Rendering), set "Emulate CSS media feature prefers-reduced-motion" to "reduce". Reload. Confirm:

- The WebGL background is static (one frame rendered, no animation) — this is pre-existing behavior, just confirm it still works.
- The submit button has no shimmer/pulse animation. Hover transitions are subtle and acceptable.

- [ ] **Step 9: Stop the dev server**

Hit `Ctrl+C` in the terminal running `npm run dev`.

- [ ] **Step 10: If everything passed, no further commit is needed**

This task is verification only. No code changes, no commit.

If any check failed, fix in `src/components/Hero.tsx` and amend the existing commit (or add a follow-up commit if amending is awkward).

---

## Done criteria

- `npx tsc --noEmit` and `npm run build` both succeed.
- Manual smoke checklist (Task 3) passes.
- One new commit on `main` (or branch) for the hero change. The design-spec commit from earlier (`f3b8091`) is already on `main`.

## Out of scope (explicit reminders)

- Do **NOT** deploy. Per `CLAUDE.md`, the user explicitly authorizes deploys; pushing to `main` only triggers staging auto-deploy, and prod is manual. This plan stops at "merged to local `main`".
- Do **NOT** modify the signup page at `app.runhq.io/signup` — handling the `?prompt=` query param is that app's responsibility.
- Do **NOT** add analytics events, tests, or new dependencies.
