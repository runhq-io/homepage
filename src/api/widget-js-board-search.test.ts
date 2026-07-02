/**
 * Tests for the discussion-board toolbar in the widget: the in-list ticket
 * SEARCH field and the "Unread only" toggle that now live together in one
 * pinned toolbar under the tab row (public/widget.js).
 *
 * As with the other widget-js suites we load the vanilla-JS IIFE via
 * vm.runInNewContext with a minimal DOM shim and drive the real render code
 * through the `_rwTestHooks` sentinel — no jsdom, no browser.
 *
 * Covers:
 *  - renderList returns [toolbar, listEl]; the toolbar carries the search box
 *    and (My Submissions only) the unread chip.
 *  - Typing in the search box filters the SAME list node in place (title/body/
 *    ref match), so the input keeps focus (the list node identity is stable).
 *  - Clearing search restores the full list.
 *  - A no-match query shows the "no matching tickets" empty state.
 *  - The unread toggle filters to unseen tickets without rebuilding the toolbar.
 *  - ticketMatchesQuery matches title, description, and the short ref id.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface FakeNode {
  nodeType: number;
  textContent: string;
  value: string;
  children: FakeNode[];
  _events: Record<string, Array<(...a: unknown[]) => void>>;
  tagName: string;
  attrs: Record<string, string | boolean>;
  style: Record<string, string>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, force?: boolean): void;
    contains(c: string): boolean;
  };
  appendChild(c: FakeNode): FakeNode;
  removeChild(c: FakeNode): FakeNode;
  setAttribute(k: string, v: string | boolean): void;
  getAttribute(k: string): string | null;
  addEventListener(ev: string, fn: (...a: unknown[]) => void): void;
  dispatchEvent(ev: { type: string; [k: string]: unknown }): void;
  focus(): void;
  get firstChild(): FakeNode | null;
  _find(pred: (n: FakeNode) => boolean): FakeNode | null;
  _findAll(pred: (n: FakeNode) => boolean): FakeNode[];
}

function classesOf(node: FakeNode): string[] {
  return String(node.attrs['class'] || '').split(' ').filter(Boolean);
}
function setClasses(node: FakeNode, list: string[]): void {
  node.attrs['class'] = list.join(' ');
}

function makeNode(tag: string): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    textContent: '',
    value: '',
    children: [],
    _events: {},
    tagName: tag.toUpperCase(),
    attrs: {},
    style: {},
    classList: {
      add(c) { const l = classesOf(node); if (!l.includes(c)) { l.push(c); setClasses(node, l); } },
      remove(c) { setClasses(node, classesOf(node).filter((x) => x !== c)); },
      toggle(c, force) {
        const has = classesOf(node).includes(c);
        const want = force === undefined ? !has : force;
        if (want) node.classList.add(c); else node.classList.remove(c);
      },
      contains(c) { return classesOf(node).includes(c); },
    },
    appendChild(c) { node.children.push(c); return c; },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i !== -1) node.children.splice(i, 1);
      return c;
    },
    setAttribute(k, v) {
      node.attrs[k] = v;
      if (k === 'value') node.value = String(v);
    },
    getAttribute(k) { return k in node.attrs ? String(node.attrs[k]) : null; },
    addEventListener(ev, fn) { (node._events[ev] || (node._events[ev] = [])).push(fn); },
    dispatchEvent(ev) { (node._events[ev.type] || []).forEach((fn) => fn(ev)); },
    focus() {},
    get firstChild() { return node.children[0] ?? null; },
    _find(pred): FakeNode | null {
      if (pred(node)) return node;
      for (const c of node.children) { const f = c._find(pred); if (f) return f; }
      return null;
    },
    _findAll(pred): FakeNode[] {
      const out: FakeNode[] = [];
      if (pred(node)) out.push(node);
      for (const c of node.children) out.push(...c._findAll(pred));
      return out;
    },
  };
  return node;
}

function makeTextNode(text: string): FakeNode {
  const n = makeNode('#text');
  n.nodeType = 3;
  n.textContent = text;
  return n;
}

function makeDomMock() {
  const scriptEl = { src: 'https://cdn.runhq.test/widget.js', getAttribute: () => 'https://cdn.runhq.test/widget.js' };
  return {
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel.includes('widget.js') ? [scriptEl] : []),
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => makeTextNode(text),
    head: makeNode('head'),
    body: { appendChild: vi.fn() },
  };
}

interface Milestone { key: string; label: string; dot: string; bg: string; fg: string }
interface Ticket { id: string; title?: string; description?: string; status?: string; currentMilestone?: Milestone | null; createdAt?: string; lastActivityAt?: string }
interface Hooks {
  renderList?: () => FakeNode[];
  fillBoardList?: () => void;
  ticketMatchesQuery?: (tk: Ticket, q: string) => boolean;
  distinctBoardProgress?: (items: Ticket[]) => Array<{ key: string; label: string; dot: string }>;
  ticketProgress?: (tk: Ticket) => { key: string; label: string; dot: string; bg: string; fg: string };
  normalizeStatus?: (s: string) => string;
  _getBoardListEl?: () => FakeNode | null;
  _setActiveTab?: (t: string) => void;
  _setSearchQuery?: (q: string) => void;
  _setStatusFilter?: (s: string) => void;
  _setUnreadOnly?: (on: boolean) => void;
  _setBoardCaches?: (c: Partial<Record<'updates' | 'hot' | 'mine' | 'approvals', Ticket[]>>) => void;
  _setConfig?: (u: Record<string, unknown>) => void;
  renderChatMessageList?: () => void;
  TICKET_LINK_SCROLL_AFTER?: number;
  _setupChatUi?: () => FakeNode;
  _setChatMessages?: (msgs: unknown[]) => void;
}

interface ChatMsg { id: string; role: string; content?: string | null; payload?: Record<string, unknown>; createdAt?: string }
function ticketLinkMsg(i: number): ChatMsg {
  return { id: `tl${i}`, role: 'event', payload: { kind: 'ticket_link', ticketId: `id${i}`, title: `Similar ticket ${i}`, status: 'done' }, createdAt: '2026-07-02T10:00:00Z' };
}

function loadWidget() {
  const source = readFileSync(join(process.cwd(), 'public', 'widget.js'), 'utf8');
  const hooks: Hooks = {};
  const windowMock: Record<string, unknown> = {
    location: { origin: 'https://customer.test', href: 'https://customer.test/' },
    onerror: null,
    addEventListener: vi.fn(),
    open: vi.fn(),
    matchMedia: () => ({ matches: false }),
    EventSource: undefined,
    _rwTestHooks: hooks,
  };
  const context: Record<string, unknown> = {
    window: windowMock,
    document: makeDomMock(),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    fetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    Date, Error, JSON, Promise, String, Number, Boolean, Array, Object, Math,
    TypeError, RangeError, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
    btoa: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
  };
  vm.runInNewContext(source, context);
  return { hooks };
}

function hasClass(n: FakeNode, cls: string): boolean {
  return classesOf(n).includes(cls);
}
function cards(listEl: FakeNode): FakeNode[] {
  // Ticket rows are the direct <button.rw-dash-row> children of the list.
  return listEl.children.filter((c) => hasClass(c, 'rw-dash-row'));
}
function findByClass(root: FakeNode, cls: string): FakeNode | null {
  return root._find((n) => hasClass(n, cls));
}
// Aggregate visible text across a node's subtree (button labels are child text
// nodes, so a node's own textContent is empty).
function textOf(n: FakeNode): string {
  let s = typeof n.textContent === 'string' ? n.textContent : '';
  for (const c of n.children) s += textOf(c);
  return s;
}

const TICKETS: Ticket[] = [
  { id: 'aaaa1111bbbb', title: 'Button hover state missing visual feedback', description: 'Several action buttons lack a hover state.' },
  { id: 'dddd2222eeee', title: 'Add Dark Mode Support to Dashboard', description: 'Add a dark mode option to the main dashboard.' },
  { id: 'ffff3333gggg', title: 'Export CSV from reports', description: 'Let users download report data as CSV.' },
];

function regionParts(region: FakeNode[]): { toolbar: FakeNode; statusRow: FakeNode | null; listEl: FakeNode } {
  const toolbar = region.find((n) => hasClass(n, 'rw-board-toolbar'))!;
  const statusRow = region.find((n) => hasClass(n, 'rw-status-filter')) ?? null;
  const listEl = region.find((n) => hasClass(n, 'rw-dash-list'))!;
  return { toolbar, statusRow, listEl };
}

function renderMineBoard(hooks: Hooks): { toolbar: FakeNode; listEl: FakeNode } {
  hooks._setConfig!({ isIdentified: true });
  hooks._setActiveTab!('hot'); // any populated tab; use hot to avoid identity gating nuances
  hooks._setBoardCaches!({ hot: TICKETS });
  hooks._setSearchQuery!('');
  hooks._setStatusFilter!('all');
  hooks._setUnreadOnly!(false);
  const region = hooks.renderList!();
  const { toolbar, statusRow, listEl } = regionParts(region);
  // TICKETS carry no status, so the status-filter row must NOT appear.
  expect(statusRow).toBeNull();
  return { toolbar, listEl };
}

const STATUS_TICKETS: Ticket[] = [
  { id: 's1', title: 'Alpha', status: 'in_progress' },
  { id: 's2', title: 'Bravo', status: 'planned' },
  { id: 's3', title: 'Charlie', status: 'in_progress' },
  { id: 's4', title: 'Delta', status: 'done' },
  { id: 's5', title: 'Echo', status: 'deployed:env-123' },
];

describe('widget.js — board search + unread toolbar', () => {
  it('renders a search box in the toolbar and all tickets in the list', () => {
    const { hooks } = loadWidget();
    const { toolbar, listEl } = renderMineBoard(hooks);

    expect(hasClass(toolbar, 'rw-board-toolbar')).toBe(true);
    expect(findByClass(toolbar, 'rw-search')).not.toBeNull();
    const input = findByClass(toolbar, 'rw-search-input');
    expect(input).not.toBeNull();
    expect(hasClass(listEl, 'rw-dash-list')).toBe(true);
    expect(cards(listEl).length).toBe(3);
  });

  it('filters the list in place as the user types, keeping the same list node (focus preserved)', () => {
    const { hooks } = loadWidget();
    const { toolbar, listEl } = renderMineBoard(hooks);
    const input = findByClass(toolbar, 'rw-search-input')!;

    // Type "dark" — only the Dark Mode ticket matches.
    input.value = 'dark';
    input.dispatchEvent({ type: 'input' });

    // Same list node is reused (identity stable ⇒ the browser keeps input focus).
    expect(hooks._getBoardListEl!()).toBe(listEl);
    const shown = cards(listEl);
    expect(shown.length).toBe(1);
    expect(shown[0]._find((n) => n.textContent.includes('Dark Mode'))).not.toBeNull();

    // The clear (×) button becomes visible once there's a query.
    const clear = findByClass(toolbar, 'rw-search-clear')!;
    expect(hasClass(clear, 'rw-show')).toBe(true);
  });

  it('shows the no-match empty state for a query that matches nothing', () => {
    const { hooks } = loadWidget();
    const { toolbar, listEl } = renderMineBoard(hooks);
    const input = findByClass(toolbar, 'rw-search-input')!;

    input.value = 'zzzzz-nothing';
    input.dispatchEvent({ type: 'input' });

    expect(cards(listEl).length).toBe(0);
    const empty = findByClass(listEl, 'rw-empty');
    expect(empty).not.toBeNull();
    expect(empty!._find((n) => n.textContent.includes('No matching'))).not.toBeNull();
  });

  it('clears the search and restores the full list when the × is clicked', () => {
    const { hooks } = loadWidget();
    const { toolbar, listEl } = renderMineBoard(hooks);
    const input = findByClass(toolbar, 'rw-search-input')!;
    input.value = 'csv';
    input.dispatchEvent({ type: 'input' });
    expect(cards(listEl).length).toBe(1);

    const clear = findByClass(toolbar, 'rw-search-clear')!;
    clear.dispatchEvent({ type: 'click' });

    expect(cards(listEl).length).toBe(3);
    expect(hasClass(clear, 'rw-show')).toBe(false);
  });

  it('shows the unread chip on My Submissions and filters to unseen without rebuilding the toolbar', () => {
    const { hooks } = loadWidget();
    hooks._setConfig!({ isIdentified: true });
    hooks._setActiveTab!('mine');
    // One ticket has newer activity than its last-seen ⇒ "unseen"; the other doesn't.
    // ticketHasUnseenActivity flags when lastActivityAt > baseline, where the
    // baseline (never opened here) is the ticket's createdAt. So: activity after
    // creation ⇒ unseen; activity before/at creation ⇒ seen.
    const mine: Ticket[] = [
      { id: 'unseen00aaaa', title: 'Unseen activity ticket', createdAt: '2026-07-01T10:00:00Z', lastActivityAt: '2026-07-02T10:00:00Z' },
      { id: 'seen0000bbbb', title: 'Already seen ticket', createdAt: '2026-07-02T10:00:00Z', lastActivityAt: '2026-07-01T09:00:00Z' },
    ];
    hooks._setBoardCaches!({ mine });
    hooks._setSearchQuery!('');
    hooks._setUnreadOnly!(false);
    const region = hooks.renderList!();
    const toolbar = region[0];
    const listEl = region[1];

    const chip = findByClass(toolbar, 'rw-unread-filter');
    expect(chip).not.toBeNull();
    expect(cards(listEl).length).toBe(2);

    // Toggle unread-only → only the unseen ticket remains; toolbar node is untouched.
    chip!.dispatchEvent({ type: 'click' });
    expect(hasClass(chip!, 'rw-on')).toBe(true);
    const shown = cards(listEl);
    expect(shown.length).toBe(1);
    expect(shown[0]._find((n) => n.textContent.includes('Unseen activity'))).not.toBeNull();
  });

  it('distinctBoardProgress orders by lifecycle and collapses deployed:<env> to one bucket', () => {
    const { hooks } = loadWidget();
    const got = hooks.distinctBoardProgress!(STATUS_TICKETS).map((p) => p.key);
    // in_progress before done before deployed; deployed:env-123 → "deployed".
    expect(got).toEqual(['planned', 'in_progress', 'done', 'deployed']);
    expect(hooks.normalizeStatus!('deployed:env-123')).toBe('deployed');
  });

  it('ticketProgress/chip use the server currentMilestone over the raw status (the reported bug)', () => {
    const { hooks } = loadWidget();
    // The bug ticket: status still 'in_progress', but an open PR advanced the
    // server milestone to "Done"/in_review. The chip + filter must follow the
    // milestone, not the stale status.
    const tk: Ticket = {
      id: 'bug1', title: 'Add Dark Mode', status: 'in_progress',
      currentMilestone: { key: 'in_review', label: 'Done', dot: '#6b8a6a', bg: 'rgba(107,138,106,0.14)', fg: '#556e54' },
    };
    const p = hooks.ticketProgress!(tk);
    expect(p.key).toBe('in_review');
    expect(p.label).toBe('Done');

    // The status-filter groups it under the milestone, labelled from the milestone.
    const groups = hooks.distinctBoardProgress!([tk]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('in_review');
    expect(groups[0].label).toBe('Done');
  });

  it('renders a status-filter row (All + each present status) only when >1 status exists', () => {
    const { hooks } = loadWidget();
    hooks._setConfig!({ isIdentified: true });
    hooks._setActiveTab!('hot');
    hooks._setBoardCaches!({ hot: STATUS_TICKETS });
    hooks._setSearchQuery!(''); hooks._setStatusFilter!('all'); hooks._setUnreadOnly!(false);
    const { statusRow, listEl } = regionParts(hooks.renderList!());

    expect(statusRow).not.toBeNull();
    const chips = statusRow!._findAll((n) => hasClass(n, 'rw-status-chip'));
    // Order = All + lifecycle order (planned, in_progress, done, deployed).
    expect(chips.length).toBe(5);
    expect(textOf(chips[0])).toContain('All');
    expect(hasClass(chips[0], 'rw-on')).toBe(true); // "All" selected by default
    expect(cards(listEl).length).toBe(5);
  });

  it('does NOT render the status row when every ticket shares one status', () => {
    const { hooks } = loadWidget();
    hooks._setConfig!({ isIdentified: true });
    hooks._setActiveTab!('hot');
    hooks._setBoardCaches!({ hot: [ { id: 'x1', title: 'A', status: 'done' }, { id: 'x2', title: 'B', status: 'done' } ] });
    hooks._setSearchQuery!(''); hooks._setStatusFilter!('all'); hooks._setUnreadOnly!(false);
    const { statusRow } = regionParts(hooks.renderList!());
    expect(statusRow).toBeNull();
  });

  it('filtering by a status chip shows only that status, in the same list node', () => {
    const { hooks } = loadWidget();
    hooks._setConfig!({ isIdentified: true });
    hooks._setActiveTab!('hot');
    hooks._setBoardCaches!({ hot: STATUS_TICKETS });
    hooks._setSearchQuery!(''); hooks._setStatusFilter!('all'); hooks._setUnreadOnly!(false);
    const { statusRow, listEl } = regionParts(hooks.renderList!());

    const chips = statusRow!._findAll((n) => hasClass(n, 'rw-status-chip'));
    const inProgress = chips[2]; // [All, planned, in_progress, done, deployed]
    inProgress.dispatchEvent({ type: 'click' });

    // Same list node reused; only the 2 in_progress tickets remain; chip is active.
    expect(hooks._getBoardListEl!()).toBe(listEl);
    expect(cards(listEl).length).toBe(2);
    expect(hasClass(inProgress, 'rw-on')).toBe(true);
    expect(hasClass(chips[0], 'rw-on')).toBe(false); // "All" no longer selected
  });

  it('status filter composes with search (AND)', () => {
    const { hooks } = loadWidget();
    hooks._setConfig!({ isIdentified: true });
    hooks._setActiveTab!('hot');
    hooks._setBoardCaches!({ hot: STATUS_TICKETS });
    hooks._setSearchQuery!(''); hooks._setStatusFilter!('all'); hooks._setUnreadOnly!(false);
    const { toolbar, statusRow, listEl } = regionParts(hooks.renderList!());

    // Filter to in_progress (2 tickets: Alpha, Charlie), then search "alpha".
    const chips = statusRow!._findAll((n) => hasClass(n, 'rw-status-chip'));
    chips[2].dispatchEvent({ type: 'click' }); // [All, planned, in_progress, done, deployed]
    const input = findByClass(toolbar, 'rw-search-input')!;
    input.value = 'alpha';
    input.dispatchEvent({ type: 'input' });

    expect(cards(listEl).length).toBe(1);
    expect(listEl._find((n) => n.textContent.includes('Alpha'))).not.toBeNull();
  });

  it('ticketMatchesQuery matches title, description, and short ref id', () => {
    const { hooks } = loadWidget();
    const tk = TICKETS[0]; // id aaaa1111bbbb → ref "AAAA1111"
    expect(hooks.ticketMatchesQuery!(tk, 'hover')).toBe(true);      // title
    expect(hooks.ticketMatchesQuery!(tk, 'action buttons')).toBe(true); // description
    expect(hooks.ticketMatchesQuery!(tk, 'aaaa1111')).toBe(true);   // ref id
    expect(hooks.ticketMatchesQuery!(tk, 'nomatch')).toBe(false);
  });
});

describe('widget.js — chat "similar tickets" grouping', () => {
  function renderChat(hooks: Hooks, ticketLinkCount: number): FakeNode {
    hooks._setConfig!({ chat: { enabled: true, agentName: 'Suha' }, projectName: 'Acme' });
    const listEl = hooks._setupChatUi!();
    const msgs: ChatMsg[] = [
      { id: 'u1', role: 'user', content: 'just create dont ask questions' },
      { id: 'a1', role: 'agent', content: 'Let me search for any existing similar tickets first!' },
    ];
    for (let i = 1; i <= ticketLinkCount; i++) msgs.push(ticketLinkMsg(i));
    hooks._setChatMessages!(msgs);
    hooks.renderChatMessageList!();
    return listEl;
  }
  function groups(listEl: FakeNode): FakeNode[] {
    return listEl.children.filter((c) => hasClass(c, 'rw-chat-ticket-link-group'));
  }

  it('collapses consecutive ticket_link cards into a single group container', () => {
    const { hooks } = loadWidget();
    const listEl = renderChat(hooks, 7);
    const g = groups(listEl);
    expect(g.length).toBe(1); // exactly one group, not 7 loose rows
    const linkCards = g[0]._findAll((n) => hasClass(n, 'rw-chat-ticket-card'));
    expect(linkCards.length).toBe(7);
  });

  it('caps + scrolls the group once it exceeds the inline threshold', () => {
    const { hooks } = loadWidget();
    const threshold = hooks.TICKET_LINK_SCROLL_AFTER!;
    const g = groups(renderChat(hooks, threshold + 3));
    expect(hasClass(g[0], 'rw-scrollable')).toBe(true);
  });

  it('leaves a small group at full height (no internal scroll)', () => {
    const { hooks } = loadWidget();
    const threshold = hooks.TICKET_LINK_SCROLL_AFTER!;
    const g = groups(renderChat(hooks, threshold)); // exactly at threshold → not scrollable
    expect(g.length).toBe(1);
    expect(hasClass(g[0], 'rw-scrollable')).toBe(false);
  });

  it('does not group ticket_link cards separated by other messages', () => {
    const { hooks } = loadWidget();
    hooks._setConfig!({ chat: { enabled: true, agentName: 'Suha' }, projectName: 'Acme' });
    const listEl = hooks._setupChatUi!();
    hooks._setChatMessages!([
      ticketLinkMsg(1),
      { id: 'a2', role: 'agent', content: 'and one more' },
      ticketLinkMsg(2),
    ]);
    hooks.renderChatMessageList!();
    // Two separate single-card groups (each run of length 1), not one merged box.
    expect(groups(listEl).length).toBe(2);
  });
});
