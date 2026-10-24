// Docs page styles. Shared tokens (--rhw-*) come from index.css.
export const DOCS_STYLES = `
  .rhp-root {
    background: var(--rhw-bg);
    color: var(--rhw-ink);
    font-family: 'Geist', 'Inter Tight', system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .rhp-root *, .rhp-root *::before, .rhp-root *::after { box-sizing: border-box; }
  .rhp-root a { color: inherit; text-decoration: none; }

  .rhp-btn-primary {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px;
    background: var(--rhw-ink); color: #fff !important;
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    border: none; cursor: pointer;
    transition: background 0.15s;
  }
  .rhp-btn-primary:hover { background: var(--rhw-accent); }
  .rhp-btn-ghost {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 18px;
    background: var(--rhw-surface);
    color: var(--rhw-ink) !important;
    border: 1px solid var(--rhw-line);
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .rhp-btn-ghost:hover { border-color: var(--rhw-ink); }

  .rhpd-shell {
    display: grid; grid-template-columns: 260px 1fr 220px;
    max-width: 1320px; margin: 0 auto;
    padding: 32px 32px 64px;
    gap: 40px;
    align-items: start;
  }
  /* HomeNav isn't sticky (it scrolls off with the page), so the sidebar, TOC
     and h2 anchors only need a small gap from the viewport top, not the
     nav's height. */
  .rhpd-side { position: sticky; top: 24px; max-height: calc(100vh - 48px); overflow-y: auto; }
  .rhpd-side-search {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 9px;
    margin-bottom: 22px;
  }
  .rhpd-side-search input {
    flex: 1; min-width: 0;
    border: 0; outline: none; background: transparent;
    font: inherit; font-size: 13px;
    color: var(--rhw-ink);
  }
  .rhpd-side-search > span:first-child { color: var(--rhw-ink-mute); }
  .rhpd-side-clear {
    background: var(--rhw-bg-2);
    border: 0;
    border-radius: 4px;
    width: 18px; height: 18px;
    line-height: 16px;
    text-align: center;
    color: var(--rhw-ink-mute);
    cursor: pointer;
    font-size: 14px;
  }
  .rhpd-side-clear:hover { color: var(--rhw-ink); }

  .rhpd-side-nav { display: flex; flex-direction: column; gap: 22px; padding-bottom: 32px; }
  .rhpd-side-sec { display: flex; flex-direction: column; gap: 2px; }
  .rhpd-side-h {
    font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 6px;
    padding: 0 8px;
  }
  .rhpd-side-i {
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--rhw-ink-soft);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    line-height: 1.45;
  }
  .rhpd-side-i:hover { background: var(--rhw-bg-2); color: var(--rhw-ink); }
  .rhpd-side-on { background: var(--rhw-ink); color: #fff !important; }

  .rhpd-main { min-width: 0; }
  .rhpd-crumbs {
    font-size: 11.5px;
    color: var(--rhw-ink-mute);
    display: flex; gap: 8px;
    margin-bottom: 12px;
    letter-spacing: 0.04em;
    flex-wrap: wrap;
  }
  .rhpd-crumbs a { color: var(--rhw-ink-mute); }
  .rhpd-crumbs a:hover { color: var(--rhw-ink); }
  .rhpd-cur { color: var(--rhw-ink); }

  .rhpd-h1 { font-size: 44px; letter-spacing: -0.028em; font-weight: 600; margin: 0 0 14px; }
  .rhpd-h2 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin: 56px 0 18px; scroll-margin-top: 24px; }
  .rhpd-lede { font-size: 17px; line-height: 1.6; color: var(--rhw-ink-soft); margin: 0 0 26px; max-width: 720px; }
  .rhpd-actions { display: inline-flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }

  .rhpd-sec { margin-bottom: 0; }
  .rhpd-p { font-size: 15px; line-height: 1.65; color: var(--rhw-ink); margin: 0 0 14px; max-width: 720px; }
  .rhpd-em { color: var(--rhw-ink); font-weight: 600; }
  .rhpd-ul, .rhpd-ol { font-size: 15px; line-height: 1.65; padding-left: 20px; margin: 0 0 14px; max-width: 720px; }
  .rhpd-ul li, .rhpd-ol li { margin-bottom: 7px; color: var(--rhw-ink); }
  .rhpd-ul li::marker { color: var(--rhw-ink-mute); }

  .rhpd-steps {
    list-style: none;
    counter-reset: rhpd-step;
    padding: 0;
    margin: 0 0 18px;
    max-width: 720px;
  }
  .rhpd-steps > li {
    counter-increment: rhpd-step;
    position: relative;
    padding-left: 36px;
    margin-bottom: 10px;
    font-size: 15px;
    line-height: 1.6;
    color: var(--rhw-ink);
  }
  .rhpd-steps > li::before {
    content: counter(rhpd-step);
    position: absolute;
    left: 0; top: 1px;
    width: 22px; height: 22px;
    border-radius: 50%;
    background: var(--rhw-ink);
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0;
  }

  .rhpd-link { color: var(--rhw-accent); border-bottom: 1px solid color-mix(in oklab, var(--rhw-accent) 35%, transparent); }
  .rhpd-link:hover { border-bottom-color: var(--rhw-accent); }

  .rhpd-kbd {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line);
    color: var(--rhw-ink);
    box-shadow: inset 0 -1px 0 var(--rhw-line);
  }

  .rhpd-pill {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 2px 8px;
    border-radius: 999px;
    margin: 0 1px;
  }
  .rhpd-pill-pending  { background: var(--rhw-bg-2); color: var(--rhw-ink-soft); }
  .rhpd-pill-progress { background: oklch(0.88 0.12 90 / 0.30); color: oklch(0.42 0.12 80); }
  .rhpd-pill-review   { background: oklch(0.85 0.14 30 / 0.25); color: oklch(0.45 0.16 30); }
  .rhpd-pill-done     { background: oklch(0.85 0.18 145 / 0.22); color: oklch(0.42 0.13 152); }
  .rhpd-pill-deployed { background: oklch(0.52 0.20 277 / 0.16); color: var(--rhw-accent); }
  .rhpd-pill-cancelled { background: var(--rhw-bg-2); color: var(--rhw-ink-mute); text-decoration: line-through; }

  .rhpd-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 6px; }
  .rhpd-card {
    display: flex; flex-direction: column; gap: 8px;
    padding: 18px 18px 16px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
    transition: border-color 0.15s, transform 0.15s;
  }
  .rhpd-card:hover { border-color: var(--rhw-ink); transform: translateY(-2px); }
  .rhpd-card-icon { font-size: 22px; }
  .rhpd-card-tag {
    font-size: 10.5px; letter-spacing: 0.06em;
    color: var(--rhw-ink-mute);
    text-transform: uppercase;
  }
  .rhpd-card-t { font-size: 15px; font-weight: 600; }
  .rhpd-card-d { font-size: 13px; color: var(--rhw-ink-soft); line-height: 1.5; flex: 1; }
  .rhpd-card-link { font-size: 12.5px; color: var(--rhw-accent); margin-top: 8px; font-weight: 500; }

  .rhpd-code-card {
    background: #0d1117;
    border-radius: 12px;
    padding: 14px 16px 16px;
    margin: 0 0 18px;
    overflow: hidden;
    max-width: 720px;
  }
  .rhpd-code-h {
    font-size: 12px; color: #b6bcc7;
    padding-bottom: 8px;
    border-bottom: 1px solid #252b36;
    margin-bottom: 8px;
    letter-spacing: 0.01em;
  }
  .rhpd-code {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px; line-height: 1.7;
    color: #e6e9ef;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .rhpd-note {
    display: flex; gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--rhw-line);
    border-left-width: 3px;
    border-radius: 8px;
    background: var(--rhw-surface);
    margin: 0 0 18px;
    font-size: 14px;
    line-height: 1.55;
    max-width: 720px;
  }
  .rhpd-note-tip { border-left-color: var(--rhw-accent); }
  .rhpd-note-warn {
    border-left-color: oklch(0.62 0.18 50);
    background: oklch(0.95 0.04 60 / 0.4);
  }
  .rhpd-note-mark {
    flex: 0 0 auto;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    padding-top: 1px;
  }

  .rhpd-changelog {
    list-style: none; padding: 0; margin: 0;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
    overflow: hidden;
  }
  .rhpd-changelog li {
    display: grid;
    grid-template-columns: 100px 1fr 60px;
    gap: 14px;
    padding: 12px 16px;
    align-items: center;
    border-bottom: 1px solid var(--rhw-line-soft);
    font-size: 13.5px;
  }
  .rhpd-changelog li:last-child { border-bottom: none; }
  .rhpd-cl-date { font-size: 11.5px; color: var(--rhw-ink-mute); }
  .rhpd-cl-t { color: var(--rhw-ink); }
  .rhpd-cl-kind {
    font-size: 10.5px; padding: 3px 8px;
    border-radius: 999px;
    text-align: center;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .rhpd-cl-feature { background: oklch(0.85 0.18 145 / 0.18); color: oklch(0.42 0.13 152); }
  .rhpd-cl-release { background: oklch(0.52 0.20 277 / 0.12); color: var(--rhw-accent); }

  .rhpd-prevnext {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 56px 0 12px;
  }
  .rhpd-pn {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 18px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
    transition: border-color 0.15s, transform 0.15s;
  }
  .rhpd-pn:hover { border-color: var(--rhw-ink); transform: translateY(-1px); }
  .rhpd-pn-prev { justify-content: flex-start; }
  .rhpd-pn-next { justify-content: flex-end; text-align: right; }
  .rhpd-pn-arrow { font-size: 20px; color: var(--rhw-ink-mute); }
  .rhpd-pn-kicker {
    display: block;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 2px;
  }
  .rhpd-pn-title { font-size: 14px; font-weight: 600; color: var(--rhw-ink); }

  .rhpd-help {
    margin-top: 36px;
    background: var(--rhw-ink);
    color: #fff;
    border-radius: 14px;
    padding: 28px 32px;
    display: flex; gap: 20px;
    align-items: center; justify-content: space-between;
    flex-wrap: wrap;
  }
  .rhpd-help-h { font-size: 18px; font-weight: 600; }
  .rhpd-help-p { color: rgba(255,255,255,0.65); margin: 4px 0 0; font-size: 13.5px; }
  .rhpd-help-r { display: inline-flex; gap: 10px; flex-wrap: wrap; }
  .rhpd-help .rhp-btn-ghost { background: transparent; color: #fff !important; border-color: rgba(255,255,255,0.2); }
  .rhpd-help .rhp-btn-ghost:hover { border-color: #fff; }
  .rhpd-help .rhp-btn-primary { background: #fff; color: var(--rhw-ink) !important; }
  .rhpd-help .rhp-btn-primary:hover { background: oklch(0.85 0.18 145); }

  .rhpd-toc { position: sticky; top: 24px; max-height: calc(100vh - 48px); overflow-y: auto; }
  .rhpd-toc-h {
    font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 12px;
  }
  .rhpd-toc-i {
    display: block;
    font-size: 12.5px;
    color: var(--rhw-ink-soft);
    padding: 5px 10px;
    border-left: 2px solid var(--rhw-line);
    cursor: pointer;
    line-height: 1.4;
    transition: color 0.15s, border-color 0.15s;
  }
  .rhpd-toc-i:hover { color: var(--rhw-ink); }
  .rhpd-toc-on { color: var(--rhw-ink); border-left-color: var(--rhw-ink); font-weight: 500; }
  .rhpd-toc-meta { font-size: 11px; color: var(--rhw-ink-faint); margin-top: 18px; padding-left: 12px; }

  .rhpd-h3 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; margin: 28px 0 10px; }
  .rhpd-h2 + .rhpd-shot, .rhpd-p + .rhpd-shot { margin-top: 4px; }

  /* Exact UI text (button, tab, menu item, field) */
  .rhpd-ui {
    font-weight: 600;
    color: var(--rhw-ink);
    background: var(--rhw-bg-2);
    border-radius: 4px;
    padding: 0 5px;
    white-space: nowrap;
  }
  .rhpd-kbd-group { white-space: nowrap; }
  .rhpd-kbd-plus { color: var(--rhw-ink-mute); margin: 0 2px; font-size: 11px; }

  /* Screenshots */
  .rhpd-shot { margin: 6px 0 26px; max-width: 880px; }
  .rhpd-shot-narrow { max-width: 520px; }
  .rhpd-shot-btn {
    display: block; width: 100%; padding: 0;
    border: 1px solid var(--rhw-line);
    border-radius: 10px;
    overflow: hidden;
    background: #0f172a;
    cursor: zoom-in;
    box-shadow: 0 1px 2px rgba(20, 19, 15, 0.06), 0 12px 32px -18px rgba(20, 19, 15, 0.35);
    transition: border-color 0.15s;
  }
  .rhpd-shot-btn:hover { border-color: var(--rhw-ink-faint); }
  .rhpd-shot-btn img { display: block; width: 100%; height: auto; }
  .rhpd-shot-cap { font-size: 13px; color: var(--rhw-ink-mute); margin-top: 8px; line-height: 1.5; }

  /* Reference tables */
  .rhpd-table-wrap { overflow-x: auto; margin: 0 0 18px; max-width: 880px; }
  .rhpd-table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.5; }
  .rhpd-table th {
    text-align: left; font-weight: 600; font-size: 12px; letter-spacing: 0.04em;
    color: var(--rhw-ink-mute); text-transform: uppercase;
    padding: 8px 12px; border-bottom: 1px solid var(--rhw-line);
  }
  .rhpd-table td { padding: 10px 12px; border-bottom: 1px solid var(--rhw-line-soft); vertical-align: top; }
  .rhpd-table td:first-child { white-space: nowrap; }

  .rhpd-locale-note {
    font-size: 13.5px; color: var(--rhw-ink-soft);
    background: var(--rhw-bg-2); border-radius: 8px;
    padding: 10px 14px; margin: 0 0 22px; max-width: 720px;
  }

  /* Mobile: the sidebar collapses behind a toggle */
  .rhpd-side-toggle { display: none; }
  @media (max-width: 800px) {
    .rhpd-side-toggle {
      display: flex; width: 100%; justify-content: space-between; align-items: center;
      padding: 10px 14px; font: inherit; font-size: 14px; font-weight: 500;
      color: var(--rhw-ink); background: var(--rhw-surface);
      border: 1px solid var(--rhw-line); border-radius: 9px; cursor: pointer;
    }
    .rhpd-side-body { display: none; margin-top: 14px; }
    .rhpd-side-open .rhpd-side-body { display: block; }
  }

  @media (max-width: 1100px) {
    .rhpd-shell { grid-template-columns: 240px 1fr; }
    .rhpd-toc { display: none; }
  }
  @media (max-width: 800px) {
    .rhpd-shell { grid-template-columns: 1fr; padding: 24px 20px 48px; gap: 24px; }
    .rhpd-side { position: static; max-height: none; }
    .rhpd-cards { grid-template-columns: 1fr; }
    .rhpd-h1 { font-size: 34px; }
    .rhpd-changelog li { grid-template-columns: 80px 1fr; row-gap: 4px; }
    .rhpd-cl-kind { display: none; }
    .rhpd-prevnext { grid-template-columns: 1fr; }
  }
`;
