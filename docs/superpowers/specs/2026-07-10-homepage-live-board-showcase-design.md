# Homepage live-board showcase — design

**Date:** 2026-07-10
**Ticket:** "showcase runhq projects homepage" — Admin: *take a look at runhq.io/arrr … can we showcase this projects on our homepage somehow? so people can see how runhq works?*

## Problem

`www.runhq.io/:slug` serves a real, full-page RunHQ **board** (the widget in standalone
mode — see `BoardPage.tsx`). `/arrr` is a live, thriving one: 579 tickets in the last
7 days, 137 contributors, 125 deploys/week. Opening it is the single most convincing way
to see how RunHQ actually works — real tickets, real agent runs, real deploys. Today the
homepage never points at these boards, so a visitor has no path from the marketing story
to the running thing.

## Goal

Add a homepage section that showcases real project boards as **live-board cards** the
visitor can open, with genuinely live numbers pulled from the public board API. Flagship
is `/arrr`; `/runhq` (our own dogfooding board) and `/moddio` are secondary.

## Approach (chosen)

A new marketing section — **"See RunHQ in action"** — inserted between *The Loop* and the
*CTA band* in `HomePage.tsx`. After the page explains the loop, this shows real boards
running it.

- **Hero card — ARRR.** Large card. Project name, one-line tagline, a row of three live
  stat tiles (**tickets this week**, **contributors**, **deploys this week**), and a
  primary `Open the live board →` affordance. The whole card links to `/arrr`.
- **Secondary cards — RunHQ, Moddio.** Smaller cards: name, one-liner, a single
  **total tickets** stat, `Open →`. Link to `/runhq` and `/moddio`.

Cards are plain `<a href="/${slug}">` — a full navigation into the board's own lazy chunk
(the board paints its own full-bleed dark canvas). Board links are **never** locale-
prefixed (`/ko/<slug>` redirects onto `/<slug>` — see `BoardPage.LocalizedBoardRedirect`),
so we do not use `useLocalePath` for them.

### Why not the alternatives

- *Embedded live board (iframe/mount):* loads the full widget bundle inline, perf/layout
  risk on a marketing page, hard to keep responsive. Rejected.
- *Static screenshot gallery:* not live; doesn't "show how RunHQ works." Rejected.

## Data — live stats with static fallback

Two public, unauthenticated GETs on mount (fetch with credentials omitted; CORS already
allows `www.runhq.io` and `staging.runhq.io`, including the `X-RW-Project` header):

1. `GET {API_BASE}/api/widget/projects` → `[{ slug, name, ticketCount }]`. Indexed by slug
   to feed the **total ticket** stat on every card. One call covers all three.
2. `GET {API_BASE}/api/widget/home-stats` with header `X-RW-Project: arrr` → weekly stats
   for the hero: `ticketsCreated7d`, `activeContributors7d`, and `sum(dailyDeployVolume)`.

`API_BASE` is reused from `../widget` (already exported, baked per-env by CI).

**Fallback.** State initializes with hardcoded numbers so first paint, localhost dev (CORS
blocks the fetch there), and any fetch failure all render sensible values. Live data
replaces them when it arrives. Fallbacks (conservative, observed 2026-07-10):

| board  | weekly tickets | contributors | weekly deploys | total tickets |
|--------|----------------|--------------|----------------|---------------|
| arrr   | 500            | 130          | 100            | 650           |
| runhq  | —              | —            | —              | 60            |
| moddio | —              | —            | —              | 20            |

Secondary cards use **total** tickets (stable, always positive) rather than 7-day stats,
because `runhq`/`moddio` weekly activity can be 0 and "0 tickets this week" reads badly.

One `useEffect`, one `AbortController`, cleaned up on unmount. Failures are swallowed
(fallback already on screen); no error UI.

## Component design

All inside `HomePage.tsx`, matching the existing pattern (self-contained page, `rhw-`
classes, translations in `HOME_T`):

- `SHOWCASE_BOARDS` — static config array: `{ slug, name, tagline-key, hero: boolean }`.
- `useBoardStats()` — small hook local to the file: holds `{ arrrWeekly, totals }` state
  seeded with fallbacks, runs the two fetches in a `useEffect`, returns current values.
- Section markup: `rhw-section-head` (eyebrow + h2 + deck) + `rhw-showcase-grid`
  (hero card spanning + two secondary cards). New CSS appended to `HOME_STYLES`, reusing
  existing tokens (`--rhw-surface`, `--rhw-line`, `--rhw-accent`, stat-tile styling
  echoing `rhw-loop` / `rhw-run` patterns). Responsive: grid collapses to one column at
  the existing 1100/720px breakpoints.

## i18n

New EN + KO keys in `HOME_T`: section eyebrow, h2 (two lines), deck, per-board taglines,
stat labels (`tickets this week`, `contributors`, `deploys this week`, `total tickets`),
and the `Open the live board →` / `Open →` CTAs. Numbers are dynamic, not translated.

## Testing / verification

- `npm run test:run` stays green (no routing changes; board routes already covered by
  `App.routing.test.ts`).
- `npm run build` succeeds.
- Manual: `npm run dev`, confirm the section renders with fallback numbers offline and
  live numbers when the API is reachable; card links navigate to `/arrr`, `/runhq`,
  `/moddio`; layout is responsive; KO locale renders translated copy.

## Out of scope

- No new backend endpoints (uses existing public widget API).
- No changes to the board/widget itself.
- No auto-discovery of boards; the featured set is a curated static list.
