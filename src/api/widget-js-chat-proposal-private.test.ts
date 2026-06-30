/**
 * Tests for the Private/Public visibility toggle on the in-chat "create ticket"
 * proposal card (public/widget.js).
 *
 * Loaded via vm.runInNewContext with a minimal DOM shim (same approach as
 * widget-js-attach-preview.test.ts), driving the private `renderChatProposalCard`
 * exposed through the `_rwTestHooks` sentinel.
 *
 * Covers:
 *  - The card renders a Public/Private pill that defaults to Public.
 *  - Clicking Create files the ticket publicly by default (isPrivate:false).
 *  - Toggling the pill flips its label/state and files privately (isPrivate:true).
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
  value: string;
  disabled: boolean;
  focus(): void;
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
    value: '',
    disabled: false,
    focus() {},
    appendChild(c) { node.children.push(c); return c; },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i !== -1) node.children.splice(i, 1);
      return c;
    },
    setAttribute(k, v) { node.attrs[k] = v; },
    getAttribute(k) { return k in node.attrs ? String(node.attrs[k]) : null; },
    addEventListener(ev, fn) { (node._events[ev] || (node._events[ev] = [])).push(fn); },
    dispatchEvent(ev) { (node._events[ev.type] || []).forEach((fn) => fn(ev)); },
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
    addEventListener: vi.fn(),
    head: makeNode('head'),
    body: { appendChild: vi.fn() },
  };
}

interface ProposalRow { payload: { title?: string; description?: string } }
interface TestHooks {
  renderChatProposalCard?: (row: ProposalRow) => FakeNode;
  _setChatConversation?: (conv: { id: string; status: string; createdTaskId: string | null }) => void;
}

function loadWidget() {
  const source = readFileSync(join(process.cwd(), 'public', 'widget.js'), 'utf8');
  const hooks: TestHooks = {};

  // fetch never resolves: we assert synchronously on the request the Create
  // click fires, without running the async post-success rendering path.
  const fetchMock = vi.fn(() => new Promise(() => {}));

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
    fetch: fetchMock,
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
  return { hooks, fetchMock };
}

function hasClass(n: FakeNode, cls: string): boolean {
  return String(n.attrs['class'] || '').split(' ').includes(cls);
}
function findPrivToggle(card: FakeNode): FakeNode | null {
  return card._find((n) => n.tagName === 'BUTTON' && hasClass(n, 'rw-priv-toggle'));
}
function findCreateBtn(card: FakeNode): FakeNode | null {
  return card._find((n) => n.tagName === 'BUTTON' && hasClass(n, 'rw-clarif-send-btn'));
}
function lastFetchBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = fetchMock.mock.calls;
  const init = calls[calls.length - 1]![1] as { body: string };
  return JSON.parse(init.body);
}

describe('widget.js — in-chat proposal card visibility toggle', () => {
  function setup() {
    const { hooks, fetchMock } = loadWidget();
    expect(hooks.renderChatProposalCard).toBeDefined();
    hooks._setChatConversation!({ id: 'conv-1', status: 'active', createdTaskId: null });
    const card = hooks.renderChatProposalCard!({ payload: { title: 'Draft', description: 'Body' } });
    return { card, fetchMock };
  }

  it('defaults to Public and files publicly', () => {
    const { card, fetchMock } = setup();
    const toggle = findPrivToggle(card);
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('data-rw-private')).toBe('false');

    findCreateBtn(card)!.dispatchEvent({ type: 'click' });

    const calls = fetchMock.mock.calls;
    expect(calls.length).toBe(1);
    expect(String(calls[0]![0])).toContain('/create-ticket');
    expect(lastFetchBody(fetchMock)).toMatchObject({
      title: 'Draft', description: 'Body', isPrivate: false,
    });
  });

  it('files privately after toggling the pill on', () => {
    const { card, fetchMock } = setup();
    const toggle = findPrivToggle(card)!;
    toggle.dispatchEvent({ type: 'click' });
    expect(toggle.getAttribute('data-rw-private')).toBe('true');

    findCreateBtn(card)!.dispatchEvent({ type: 'click' });

    expect(lastFetchBody(fetchMock)).toMatchObject({
      title: 'Draft', description: 'Body', isPrivate: true,
    });
  });
});
