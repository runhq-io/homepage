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
  _setLiveSessionState?: (
    ticket: { id?: string; title?: string } | null,
    chatConfig?: { enabled?: boolean; agentName?: string } | null,
  ) => void;
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
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
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
    // The ticket title is surfaced as the heading.
    const heading = intro._find((n) => hasClass(n, 'rw-chat-intro-title'));
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe('Deploy to production');
    // The body names the agent and promises updates here + a done note.
    const text = allText(intro);
    expect(text).toContain('Suha (Support)');
    expect(text.toLowerCase()).toContain('background');
    expect(text.toLowerCase()).toContain('done');
  });

  it('still renders a useful body when the ticket has no title', () => {
    const { hooks } = loadWidget();
    hooks._setLiveSessionState!({ id: 't2' }, { enabled: true, agentName: 'Suha (Support)' });
    const intro = hooks.renderLiveSessionIntro!();
    expect(intro._find((n) => hasClass(n, 'rw-chat-intro-title'))).toBeNull();
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
