/**
 * Tests for the widget Live-session affordances in public/widget.js (vanilla JS
 * IIFE), loaded via vm.runInNewContext with a minimal DOM shim (no jsdom) and
 * driven through the private functions exposed on the `_rwTestHooks` sentinel.
 *
 * Covers two Live-session fixes:
 *  - Empty Live session no longer reads as a blank screen: `renderLiveSessionIntro`
 *    acknowledges the ticket by title and explains that the agent is working in
 *    the background and will post updates here.
 *  - Multiple staff in a Live session are distinguishable: `renderChatTeamRow`
 *    attributes each mirrored team message to its author (payload.authorName),
 *    falling back to the generic "Team" label only when no name is present.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface FakeNode {
  nodeType: number;
  textContent: string;
  children: FakeNode[];
  _events: Record<string, Array<(...a: unknown[]) => void>>;
  tagName: string;
  attrs: Record<string, string | boolean>;
  style: Record<string, string>;
  appendChild(c: FakeNode): FakeNode;
  removeChild(c: FakeNode): FakeNode;
  setAttribute(k: string, v: string | boolean): void;
  getAttribute(k: string): string | null;
  addEventListener(ev: string, fn: (...a: unknown[]) => void): void;
  dispatchEvent(ev: { type: string; [k: string]: unknown }): void;
  get firstChild(): FakeNode | null;
  _find(pred: (n: FakeNode) => boolean): FakeNode | null;
  _findAll(pred: (n: FakeNode) => boolean): FakeNode[];
}

function makeNode(tag: string): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    textContent: '',
    children: [],
    _events: {},
    tagName: tag.toUpperCase(),
    attrs: {},
    style: {},
    appendChild(c) { node.children.push(c); return c; },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i !== -1) node.children.splice(i, 1);
      return c;
    },
    setAttribute(k, v) { node.attrs[k] = v; },
    getAttribute(k) { return k in node.attrs ? String(node.attrs[k]) : null; },
    addEventListener(ev, fn) {
      (node._events[ev] || (node._events[ev] = [])).push(fn);
    },
    dispatchEvent(ev) {
      (node._events[ev.type] || []).forEach((fn) => fn(ev));
    },
    get firstChild() { return node.children[0] ?? null; },
    _find(pred): FakeNode | null {
      if (pred(node)) return node;
      for (const c of node.children) {
        const f = c._find(pred);
        if (f) return f;
      }
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
  const scriptEl = {
    src: 'https://cdn.runhq.test/widget.js',
    getAttribute: () => 'https://cdn.runhq.test/widget.js',
  };
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

interface TestHooks {
  renderLiveSessionIntro?: () => FakeNode;
  renderChatTeamRow?: (row: { payload?: { authorName?: string } | null; content?: string }) => FakeNode;
  renderChatEventRow?: (
    row: { id?: string; payload?: Record<string, unknown> | null },
    activeProposal?: unknown,
  ) => FakeNode | null;
  statusMeta?: (s: string) => { label: string; dot: string; bg: string; fg: string };
  renderStatusChip?: (s: string) => FakeNode;
  setDeployEnvironments?: (list: Array<{ id: string; name: string }>) => void;
  _setLiveSessionState?: (
    ticket: { id?: string; title?: string } | null,
    chatConfig?: { enabled?: boolean; agentName?: string } | null,
  ) => void;
  launcherBadgeCount?: () => number;
  markTicketSeen?: (id: string, whenMs: number) => void;
  markLiveSessionSeen?: (id: string, whenMs: number) => void;
  hasUnreadLiveSession?: (ticket: unknown) => boolean;
  _setCaches?: (mine: unknown[], assigned: unknown[]) => void;
  _setConfig?: (updates: Record<string, unknown>) => void;
  _setCurrentUser?: (updates: Record<string, unknown>) => void;
  viewerCanLiveCoder?: () => boolean;
}

function makeLocalStorageMock() {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
}

function loadWidget() {
  const source = readFileSync(join(process.cwd(), 'public', 'widget.js'), 'utf8');
  const hooks: TestHooks = {};
  const windowMock: Record<string, unknown> = {
    location: { origin: 'https://customer.test', href: 'https://customer.test/' },
    onerror: null,
    addEventListener: vi.fn(),
    open: vi.fn(),
    EventSource: undefined,
    _rwTestHooks: hooks,
    // The status registry the widget normally gets injected at page load.
    __RW_CONSTANTS__: {
      status: {
        pending: { label: 'Pending', dot: '#8a857d', bg: '#eee', fg: '#555' },
        in_progress: { label: 'In progress', dot: '#c79a2e', bg: '#fef', fg: '#8a6d1f' },
        needs_review: { label: 'In review', dot: '#6366f1', bg: '#eef', fg: '#3a3a8a' },
        done: { label: 'Done', dot: '#4a7558', bg: '#efe', fg: '#3a5a44' },
        deployed: { label: 'Deployed', dot: '#4a7558', bg: '#dfe', fg: '#3a5a44' },
      },
    },
  };
  const context: Record<string, unknown> = {
    window: windowMock,
    document: makeDomMock(),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    fetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    Date, Error, JSON, Promise, String, Number, Boolean, Array, Object, Math,
    TypeError, RangeError,
    URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
    // Functional localStorage so markTicketSeen/getTicketSeen round-trips work
    // in vm tests (unlike a stub that always returns null).
    localStorage: makeLocalStorageMock(),
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
    btoa: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
  };
  vm.runInNewContext(source, context);
  return { hooks };
}

function hasClass(n: FakeNode, cls: string): boolean {
  return String(n.attrs['class'] || '').split(' ').includes(cls);
}
function allText(n: FakeNode): string {
  if (n.nodeType === 3 || (typeof n.textContent === 'string' && n.children.length === 0)) {
    return n.textContent || '';
  }
  return n.children.map(allText).join(' ');
}

describe('widget.js — Live session opening acknowledgement', () => {
  it('names the ticket and sets background-work expectations (no blank screen)', () => {
    const { hooks } = loadWidget();
    expect(hooks.renderLiveSessionIntro).toBeDefined();
    hooks._setLiveSessionState!(
      { id: 't1', title: 'Deploy to production' },
      { enabled: true, agentName: 'Suha (Support)' },
    );
    const intro = hooks.renderLiveSessionIntro!();

    // Styled like the intake empty state, not a fabricated chat bubble.
    expect(hasClass(intro, 'rw-chat-empty')).toBe(true);
    expect(hasClass(intro, 'rw-chat-intro')).toBe(true);
    // Signature: a live "working" pill (with a decorative pulse dot) that names
    // the agent and signals background activity.
    const status = intro._find((n) => hasClass(n, 'rw-intro-status'));
    expect(status).not.toBeNull();
    expect(status!._find((n) => hasClass(n, 'rw-intro-pulse'))).not.toBeNull();
    expect(allText(status!)).toContain('Suha (Support)');
    expect(allText(status!).toLowerCase()).toContain('background');
    // The ticket title is surfaced as the focal subject, with the full text on
    // hover (title=) so the CSS line-clamp can truncate long subjects safely.
    const heading = intro._find((n) => hasClass(n, 'rw-chat-intro-title'));
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe('Deploy to production');
    expect(heading!.getAttribute('title')).toBe('Deploy to production');
    // The body sets expectations and invites a reply.
    const body = intro._find((n) => hasClass(n, 'rw-intro-body'));
    expect(body!.textContent.toLowerCase()).toContain('updates');
    expect(body!.textContent.toLowerCase()).toContain('message anytime');
  });

  it('preserves the full title on hover even when long (CSS clamps the display)', () => {
    const { hooks } = loadWidget();
    const long = 'can you add a search button here for PR/branches/worktree so for example when a user opens it';
    hooks._setLiveSessionState!({ id: 't3', title: long }, { enabled: true, agentName: 'Suha (Support)' });
    const heading = hooks.renderLiveSessionIntro!()._find((n) => hasClass(n, 'rw-chat-intro-title'));
    // Full text is retained (not pre-truncated in JS); the ellipsis is purely CSS.
    expect(heading!.textContent).toBe(long);
    expect(heading!.getAttribute('title')).toBe(long);
  });

  it('still renders the status pill when the ticket has no title', () => {
    const { hooks } = loadWidget();
    hooks._setLiveSessionState!({ id: 't2' }, { enabled: true, agentName: 'Suha (Support)' });
    const intro = hooks.renderLiveSessionIntro!();
    expect(intro._find((n) => hasClass(n, 'rw-chat-intro-title'))).toBeNull();
    expect(intro._find((n) => hasClass(n, 'rw-intro-status'))).not.toBeNull();
    expect(allText(intro)).toContain('Suha (Support)');
  });
});

describe('widget.js — Live session team-message attribution', () => {
  it('shows the sender name for a mirrored staff reply', () => {
    const { hooks } = loadWidget();
    expect(hooks.renderChatTeamRow).toBeDefined();
    const row = hooks.renderChatTeamRow!({ payload: { authorName: 'Alex' }, content: 'Pushed a fix.' });
    const name = row._find((n) => hasClass(n, 'rw-chat-agent-name'));
    expect(name).not.toBeNull();
    expect(name!.textContent).toBe('Alex');
  });

  it('falls back to the generic "Team" label when no author is attributed', () => {
    const { hooks } = loadWidget();
    const row = hooks.renderChatTeamRow!({ payload: null, content: 'Pushed a fix.' });
    const name = row._find((n) => hasClass(n, 'rw-chat-agent-name'));
    expect(name!.textContent).toBe('Team');
  });
});

describe('widget.js — status/milestone activity mirrored into the live session', () => {
  it('renders a milestone (agent_update) as an inline event line with its text', () => {
    const { hooks } = loadWidget();
    expect(hooks.renderChatEventRow).toBeDefined();
    const node = hooks.renderChatEventRow!({
      id: 'e1',
      payload: { kind: 'activity', activityType: 'agent_update', content: 'Deploying to production now.', metadata: null },
    });
    expect(node).not.toBeNull();
    expect(hasClass(node!, 'rw-chat-event-line')).toBe(true);
    // agent_update renders its (already-screened) content verbatim via describeEvent.
    expect(allText(node!)).toContain('Deploying to production now.');
  });

  it('renders a PR-merged activity as a code-safe inline line (never the PR number)', () => {
    const { hooks } = loadWidget();
    const node = hooks.renderChatEventRow!({
      id: 'e2',
      payload: { kind: 'activity', activityType: 'pr_linked', content: null, metadata: { state: 'merged', prNumber: 123 } },
    });
    expect(node).not.toBeNull();
    const text = allText(node!);
    expect(text.length).toBeGreaterThan(0);
    // Never leaks the raw activity type or the PR number into the thread.
    expect(text).not.toContain('pr_linked');
    expect(text).not.toContain('123');
  });

  it('renders a status_change as from→to chips (matching the public activity page)', () => {
    const { hooks } = loadWidget();
    const node = hooks.renderChatEventRow!({
      id: 'e3',
      payload: { kind: 'activity', activityType: 'status_change', content: null, metadata: { from: 'in_progress', to: 'needs_review' } },
    });
    expect(node).not.toBeNull();
    expect(hasClass(node!, 'rw-chat-event-chips')).toBe(true);
    // Two status chips (from + to) — the clear transition, not vague text.
    const chips = node!._findAll((n) => hasClass(n, 'rw-chip'));
    expect(chips.length).toBe(2);
    expect(allText(node!)).not.toContain('status_change');
  });

  it('renders a single chip when a status_change has only a target', () => {
    const { hooks } = loadWidget();
    const node = hooks.renderChatEventRow!({
      id: 'e4',
      payload: { kind: 'activity', activityType: 'status_change', content: null, metadata: { to: 'done' } },
    });
    expect(node!._findAll((n) => hasClass(n, 'rw-chip')).length).toBe(1);
  });
});

describe('widget.js — deployed:<envId> status resolves to an env name', () => {
  it('labels a deployed status "Deployed → <env name>" using the synced env map', () => {
    const { hooks } = loadWidget();
    hooks.setDeployEnvironments!([{ id: 'denv_ec106c0a7c6b4644', name: 'Production' }]);
    expect(hooks.statusMeta!('deployed:denv_ec106c0a7c6b4644').label).toBe('Deployed → Production');
    // Carries the base `deployed` colors (not the gray fallback).
    expect(hooks.statusMeta!('deployed:denv_ec106c0a7c6b4644').dot).toBe('#4a7558');
  });

  it('falls back to "Deployed" for an unknown env id or the bare status (never the raw id)', () => {
    const { hooks } = loadWidget();
    hooks.setDeployEnvironments!([{ id: 'denv_known', name: 'Production' }]);
    expect(hooks.statusMeta!('deployed:denv_unknown').label).toBe('Deployed');
    expect(hooks.statusMeta!('deployed').label).toBe('Deployed');
    // Crucially, the raw env id never surfaces as the label.
    expect(hooks.statusMeta!('deployed:denv_unknown').label).not.toContain('denv_');
  });

  it('renders the resolved name in a status chip (the public-page + live-session path)', () => {
    const { hooks } = loadWidget();
    hooks.setDeployEnvironments!([{ id: 'denv_x', name: 'Staging' }]);
    const chip = hooks.renderStatusChip!('deployed:denv_x');
    expect(allText(chip)).toContain('Staging');
    expect(allText(chip)).not.toContain('denv_x');
  });

  it('resolves the env name inside a live-session status_change chip (A + B together)', () => {
    const { hooks } = loadWidget();
    hooks.setDeployEnvironments!([{ id: 'denv_x', name: 'Production' }]);
    const node = hooks.renderChatEventRow!({
      id: 'e5',
      payload: { kind: 'activity', activityType: 'status_change', content: null, metadata: { from: 'done', to: 'deployed:denv_x' } },
    });
    expect(allText(node!)).toContain('Production');
    expect(allText(node!)).not.toContain('denv_x');
  });
});

describe('live-session unread badge (assigner)', () => {
  it('counts an assigned session with an unread reply; only opening the session clears it (NOT viewing the detail)', () => {
    const { hooks } = loadWidget();
    // Simulate a logged-in staff viewer with live_coder permission.
    hooks._setConfig!({ isIdentified: true });
    hooks._setCurrentUser!({ permissions: ['live_coder'] });

    const now = Date.now();
    const ticket = {
      id: 'task-1',
      title: 'Assigned',
      createdAt: new Date(now - 10000).toISOString(),
      // An unread coder reply landed AT now; the general-activity axis is even
      // newer (a later status sync), to reproduce the prod bug where the detail
      // mark would otherwise mask the older reply.
      lastActivityAt: new Date(now + 5000).toISOString(),
      liveSessionLastMessageAt: new Date(now).toISOString(),
    };

    // Seed the assigned-ticket cache (simulates what loadAssignedTickets sets).
    hooks._setCaches!([], [ticket]);

    // The assigned session has an unread reply (no live-session-seen record).
    expect(hooks.launcherBadgeCount!()).toBe(1);

    // Merely viewing the ticket DETAIL marks the ticket seen up to its general
    // activity (later than the reply) — this must NOT clear the live-session
    // signal (the prod bug). Badge stays lit.
    hooks.markTicketSeen!('task-1', now + 5000);
    expect(hooks.launcherBadgeCount!()).toBe(1);

    // Opening the live session advances the dedicated mark → cleared.
    hooks.markLiveSessionSeen!('task-1', now);
    expect(hooks.launcherBadgeCount!()).toBe(0);
  });

  it('viewerCanLiveCoder gates on live_coder only (assign_agent alone is false)', () => {
    const { hooks } = loadWidget();

    // assign_agent without live_coder — cannot open the session, badge must stay dark.
    hooks._setCurrentUser!({ permissions: ['assign_agent'] });
    expect(hooks.viewerCanLiveCoder!()).toBe(false);

    // live_coder — can open the session, badge should light.
    hooks._setCurrentUser!({ permissions: ['live_coder'] });
    expect(hooks.viewerCanLiveCoder!()).toBe(true);
  });
});
