# Evolve tool — design export

A snapshot of the **Evolve** tool's current UI in the RunHQ console, meant to be
handed to Claude Design for review. Every screen was rendered by the console's real
components (`runhq-cloud/client/src/components/evolve/`) on fictional
sample data. No real customer data is included.

- `index.html`: open this first. It links every screen.
- `html/`: one static HTML file per screen. There are no scripts, and the CSS and fonts are inlined, so each file opens on its own.
- `png/`: full-height screenshots, 1440px wide, of the same screens.

## How Evolve works (context for the reviewer)

Evolve runs product experiments as **generations** of **variations**, for example
three onboarding flows behind a traffic split. The loop:

1. **Suggest.** A job reads the project and writes a *proposal*: a goal,
   the variations, a traffic split, the analytics sources it needs and any open questions.
2. **Approve and build.** The user edits the proposal and approves it. A coding job then
   builds the variations and opens a PR, and the generation is registered once it's built.
3. **Live.** The generation runs. Analytics tracking and data sources (web APIs
   or commands) supply the numbers.
4. **Assess.** A job reads the data and judges each variation (Keep / Winner / Modify…).
   It then recommends a next step.
5. **Decide.** The user picks one: modify variations, keep monitoring, start a new generation, or stop.

The screen has three tabs: **Current** (or **Generation N**), **History**, and **Data sources**.

## Screens

| File | State |
|---|---|
| `evolve-live` | Generation 3 live — assessed, next step waiting for a decision |
| `evolve-not-active` | Not active — no generation, tracking off, no data sources |
| `evolve-proposal` | A proposal for generation 3 waiting for approval |
| `evolve-suggesting` | The job writing a proposal is running |
| `evolve-building` | An approved proposal being built |
| `evolve-assessing` | Generation 3 live, its assessment running |
| `evolve-decided` | Generation 3 live, the next step already chosen |
| `evolve-error` | Evolve could not be read |
| `evolve-history` | History — past generations, their assessments and decisions |
| `evolve-history-assessment` | History — one past assessment opened |
| `evolve-sources` | Data sources — a web API and a command |
| `evolve-source-add` | Data sources — add one (dialog) |
| `evolve-report` | The assessment’s full report (dialog) |
| `evolve-decide-modify` | Modify variations — the job’s instructions (dialog) |
| `evolve-decide-stop` | Stop generation 3 (confirm) |
| `evolve-variation-edit` | Edit a variation (dialog) |
| `evolve-proposal-build` | Build generation 3 — the job’s instructions (dialog) |
| `evolve-proposal-edit-goal` | Edit the proposal’s goal (dialog) |
| `evolve-proposal-add-source` | Add the proposal’s suggested source, pre-filled (dialog) |
| `evolve-record-manually` | Record variations that already run (the secondary form) |
## Regenerating

The export comes from the design-snapshot harness in runhq-cloud:

```bash
cd runhq-cloud/client
node design-snapshots/capture.mjs evolve-   # writes ../.mockups/crm/evolve-*.html
```

Fixtures live in `client/design-snapshots/fixtures/evolve.ts`, and the page list is in
`client/design-snapshots/pages/60-evolve.mjs`. To make the PNGs, open each HTML file in Playwright
at 1440px. Grow the viewport by the inner pane's scroll overflow, because the app scrolls inside a pane rather than the window.

Exported 2026-10-24 from runhq-cloud `2e4a4fa63`.
