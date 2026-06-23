/**
 * Tests for the Preview button rendered in the widget ticket-detail view.
 *
 * The widget UI lives in public/widget.js (vanilla JS IIFE). We load it via
 * vm.runInNewContext so we can inject a controlled `fetch` + `window` mock
 * without a real browser.  A minimal DOM shim is provided so `renderDetailInto`
 * can create elements and event listeners without jsdom.
 *
 * We call `renderDetailInto` via `window._rwTestHooks` — a minimal hook added
 * at the bottom of widget.js that is populated with the private function when
 * the `_rwTestHooks` sentinel object is present on `window` at load time. This
 * is the only modification to widget.js; it has zero production impact because
 * real browsers never set `_rwTestHooks`.
 *
 * Covers:
 *  - Preview button NOT rendered when canPreview is false (node absent in DOM)
 *  - Preview button IS rendered when canPreview is true (node present in DOM)
 *  - Click POSTs to /api/widget/tickets/:id/preview
 *  - On { ok:true, url } → window.open is called with that url
 *  - On { ok:true, status:'preparing' } (no url) → poll fires, then window.open
 *  - On { ok:false } → shows error, window.open NOT called
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

type EventMap = Record<string, Array<(...args: unknown[]) => void>>;

interface FakeNode {
  nodeType: number;
  textContent: string;
  children: FakeNode[];
  _events: EventMap;
  tagName: string;
  attrs: Record<string, string | boolean>;
  style: Record<string, string>;
  disabled: boolean;
  value: string;
  // DOM-like API
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  setAttribute(k: string, v: string | boolean): void;
  getAttribute(k: string): string | null;
  addEventListener(ev: string, fn: (...args: unknown[]) => void): void;
  dispatchEvent(ev: { type: string; [k: string]: unknown }): void;
  querySelector(sel: string): FakeNode | null;
  querySelectorAll(sel: string): FakeNode[];
  get firstChild(): FakeNode | null;
  get lastChild(): FakeNode | null;
  focus(): void;
  // helpers for assertions
  _text(): string;
  _find(predicate: (n: FakeNode) => boolean): FakeNode | null;
  _findAll(predicate: (n: FakeNode) => boolean): FakeNode[];
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
    disabled: false,
    value: '',

    appendChild(child) {
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
      return child;
    },
    setAttribute(k, v) { node.attrs[k] = v; },
    getAttribute(k) { return k in node.attrs ? String(node.attrs[k]) : null; },
    addEventListener(ev, fn) {
      if (!node._events[ev]) node._events[ev] = [];
      node._events[ev].push(fn as (...args: unknown[]) => void);
    },
    dispatchEvent(ev) {
      const handlers = node._events[ev.type] || [];
      handlers.forEach((fn) => fn(ev));
    },
    querySelector(sel) {
      // support class selector (.foo) and attribute selector ([class*=foo])
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      return node._find((n) => {
        if (!cls) return false;
        const c = n.attrs['class'] || '';
        return String(c).split(' ').includes(cls);
      });
    },
    querySelectorAll(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      return node._findAll((n) => {
        if (!cls) return false;
        const c = n.attrs['class'] || '';
        return String(c).split(' ').includes(cls);
      });
    },
    get firstChild() { return node.children[0] ?? null; },
    get lastChild() { return node.children[node.children.length - 1] ?? null; },
    focus() {},

    _text() {
      if (node.children.length === 0) return node.textContent;
      return node.children.map((c) => c._text()).join('');
    },
    _find(pred): FakeNode | null {
      if (pred(node)) return node;
      for (const c of node.children) {
        const found = c._find(pred);
        if (found) return found;
      }
      return null;
    },
    _findAll(pred): FakeNode[] {
      const result: FakeNode[] = [];
      if (pred(node)) result.push(node);
      for (const c of node.children) {
        result.push(...c._findAll(pred));
      }
      return result;
    },
  };
  return node;
}

function makeTextNode(text: string): FakeNode {
  const n = makeNode('#text');
  n.nodeType = 3;
  n.textContent = text;
  n._text = () => text;
  return n;
}

function makeDomMock() {
  const scriptEl = {
    src: 'https://cdn.runhq.test/widget.js',
    getAttribute: vi.fn(() => 'https://cdn.runhq.test/widget.js'),
  };
  return {
    // Return null for "runhq-widget-host" so init() does not bail early.
    querySelector: vi.fn((_sel: string) => null),
    querySelectorAll: vi.fn((sel: string) => {
      if (sel.includes('widget.js')) return [scriptEl];
      return [];
    }),
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => makeTextNode(text),
    head: makeNode('head'),
    body: { appendChild: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Widget loader
// ---------------------------------------------------------------------------

type FetchImpl = (url: string, init: RequestInit) => Promise<unknown>;

interface TestHooks {
  renderDetailInto?: (card: FakeNode, data: unknown, loading: boolean) => void;
}

interface WidgetApi {
  init(opts: Record<string, unknown>): void;
}

function loadWidget(
  fetchImpl: FetchImpl,
  windowExtra: Record<string, unknown> = {},
): { api: WidgetApi; hooks: TestHooks } {
  const source = readFileSync(join(process.cwd(), 'public', 'widget.js'), 'utf8');
  // The _rwTestHooks sentinel: widget.js assigns renderDetailInto to it if present.
  const testHooks: TestHooks = {};
  const windowMock: Record<string, unknown> = {
    location: { origin: 'https://customer.test', href: 'https://customer.test/' },
    onerror: null,
    addEventListener: vi.fn(),
    open: vi.fn(),
    EventSource: undefined,       // force polling path
    _rwTestHooks: testHooks,
    ...windowExtra,
  };
  const context: Record<string, unknown> = {
    window: windowMock,
    document: makeDomMock(),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    fetch: fetchImpl,
    Date,
    Error,
    JSON,
    Promise,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Math,
    TypeError,
    RangeError,
    URL,
    FormData: class FormData {
      private _entries: [string, unknown][] = [];
      append(k: string, v: unknown) { this._entries.push([k, v]); }
    },
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    parseFloat,
    parseInt,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
    btoa: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
  };

  vm.runInNewContext(source, context);
  return {
    api: (windowMock as { RunHQWidget: WidgetApi }).RunHQWidget,
    hooks: testHooks,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ticket detail returned by GET /api/widget/tickets/:id */
function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    ticket: {
      id: 'tkt-001',
      title: 'Fix the bug',
      status: 'in_progress',
      yesVotes: 0,
      userVote: null,
      isPrivate: false,
      description: 'Steps to reproduce',
      attachments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignedAgentName: null,
      lastTriager: null,
    },
    comments: [],
    activity: [],
    isOwner: false,
    isEditable: false,
    clarification: null,
    milestones: [],
    canPreview: false,
    ...overrides,
  };
}

/** Find the rw-preview-btn node inside the rendered card, or null. */
function findPreviewBtn(card: FakeNode): FakeNode | null {
  return card._find((n) => {
    const cls = String(n.attrs['class'] || '');
    return cls.split(' ').includes('rw-preview-btn');
  });
}

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

/**
 * Pump microtask + timer queue enough times that pending promises resolve.
 * We need several ticks because the widget chains .then() handlers.
 */
async function flushAsync(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('widget.js — Preview button in ticket detail', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Button not rendered when canPreview is false
  //    REAL DOM CHECK: call renderDetailInto with canPreview:false; assert
  //    the rw-preview-btn node is absent from the rendered tree.
  // -------------------------------------------------------------------------
  it('does NOT render a rw-preview-btn node when canPreview is false', () => {
    const { hooks } = loadWidget(async () => jsonOk({}));
    // hooks.renderDetailInto is populated by the IIFE via _rwTestHooks
    expect(hooks.renderDetailInto).toBeDefined();

    const card = makeNode('div');
    hooks.renderDetailInto!(card, makeDetail({ canPreview: false }), false);

    const btn = findPreviewBtn(card);
    expect(btn).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Button IS rendered when canPreview is true
  //    REAL DOM CHECK: call renderDetailInto with canPreview:true; assert
  //    the rw-preview-btn node is present in the rendered tree.
  // -------------------------------------------------------------------------
  it('renders a rw-preview-btn node when canPreview is true', () => {
    const { hooks } = loadWidget(async () => jsonOk({}));

    const card = makeNode('div');
    hooks.renderDetailInto!(card, makeDetail({ canPreview: true }), false);

    const btn = findPreviewBtn(card);
    expect(btn).not.toBeNull();
    // The button must be a button element tagged "BUTTON"
    expect(btn!.tagName).toBe('BUTTON');
  });

  // -------------------------------------------------------------------------
  // 3. Click → POSTs to the preview endpoint → window.open called on ready
  //    REAL BUTTON DRIVE: render the button, dispatch a click event, assert
  //    fetch was called with the correct preview URL and window.open was called
  //    with the preview url returned in the response.
  // -------------------------------------------------------------------------
  it('click POSTs to preview endpoint and calls window.open on a ready response', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const windowOpen = vi.fn();
    const previewUrl = 'https://3101.preview.x?__preview_token=tok';

    const { hooks } = loadWidget(
      async (url, init) => {
        fetchCalls.push({ url, init });
        if (url.includes('/preview')) {
          return jsonOk({ ok: true, url: previewUrl, status: 'ready' });
        }
        return jsonOk({});
      },
      { open: windowOpen },
    );

    const card = makeNode('div');
    hooks.renderDetailInto!(card, makeDetail({ canPreview: true }), false);

    const btn = findPreviewBtn(card);
    expect(btn).not.toBeNull();

    // Simulate a click — this triggers the widget's real click handler which
    // calls startTicketPreview → api() → fetch().
    btn!.dispatchEvent({ type: 'click' });

    // Flush microtasks so the fetch promise resolves and .then() handlers fire.
    await flushAsync();

    // Verify: fetch was called with the preview endpoint.
    const previewCall = fetchCalls.find((c) => c.url.includes('/preview'));
    expect(previewCall).toBeDefined();
    expect(previewCall!.url).toMatch(/\/api\/widget\/tickets\/tkt-001\/preview$/);
    expect(previewCall!.init.method).toBe('POST');

    // Verify: window.open was called with the preview url.
    expect(windowOpen).toHaveBeenCalledWith(previewUrl, '_blank', 'noopener');
  });

  // -------------------------------------------------------------------------
  // 4. On { ok:false } → no window.open, error shown
  //    REAL BUTTON DRIVE: click the button, fetch returns ok:false; assert
  //    window.open is NOT called.
  // -------------------------------------------------------------------------
  it('does NOT call window.open on an ok:false response', async () => {
    const windowOpen = vi.fn();

    const { hooks } = loadWidget(
      async (url) => {
        if (url.includes('/preview')) {
          return jsonOk({ ok: false, reason: 'no_preview' });
        }
        return jsonOk({});
      },
      { open: windowOpen },
    );

    const card = makeNode('div');
    hooks.renderDetailInto!(card, makeDetail({ canPreview: true }), false);

    const btn = findPreviewBtn(card);
    expect(btn).not.toBeNull();
    btn!.dispatchEvent({ type: 'click' });
    await flushAsync();

    // Window.open must never be called.
    expect(windowOpen).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. preparing → poll → ready: window.open eventually called
  //    REAL BUTTON DRIVE + FAKE TIMERS: first POST returns { ok:true, no url }
  //    (preparing state); we advance fake timers past the 1500ms poll interval;
  //    the poll GET returns { ok:true, url }; assert window.open is called.
  //
  //    vi.useFakeTimers() is called BEFORE loadWidget so the vm context
  //    receives the fake setTimeout — that means the widget's internal poll
  //    setTimeout is also fake and fully controllable.
  // -------------------------------------------------------------------------
  it('polls until a url arrives: preparing then ready → window.open called', async () => {
    vi.useFakeTimers();

    const windowOpen = vi.fn();
    const previewUrl = 'https://3101.preview.x?__preview_token=tok2';
    let callCount = 0;

    const { hooks } = loadWidget(
      async (url) => {
        if (url.includes('/preview')) {
          callCount++;
          if (callCount === 1) {
            // First POST: preparing — no url
            return jsonOk({ ok: true, status: 'preparing' });
          }
          // Subsequent polls: ready with url
          return jsonOk({ ok: true, url: previewUrl, status: 'ready' });
        }
        return jsonOk({});
      },
      { open: windowOpen },
    );

    const card = makeNode('div');
    hooks.renderDetailInto!(card, makeDetail({ canPreview: true }), false);

    const btn = findPreviewBtn(card);
    expect(btn).not.toBeNull();
    btn!.dispatchEvent({ type: 'click' });

    // Flush the initial POST promise chain.
    await vi.runAllTicks();
    await vi.runAllTicks();

    // First POST resolved with 'preparing' — window.open must NOT have fired yet.
    expect(windowOpen).not.toHaveBeenCalled();

    // Advance fake timers past the widget's 1500ms poll interval.
    await vi.advanceTimersByTimeAsync(1600);

    // The poll fetch now resolves with the ready url — flush those promises.
    await vi.runAllTicks();
    await vi.runAllTicks();

    // window.open must now have been called with the preview url.
    expect(windowOpen).toHaveBeenCalledWith(previewUrl, '_blank', 'noopener');
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // 6. previewStarting guard: double-click does not fire two POSTs
  //    REAL BUTTON DRIVE: click twice before the first fetch resolves; assert
  //    only one POST was sent (the second click is ignored while polling).
  // -------------------------------------------------------------------------
  it('ignores a second click while a preview is already starting', async () => {
    const fetchCalls: Array<{ url: string }> = [];
    let resolveFirst!: (v: unknown) => void;
    const firstPreview = new Promise((r) => { resolveFirst = r; });

    const { hooks } = loadWidget(async (url) => {
      if (url.includes('/preview')) {
        fetchCalls.push({ url });
        return firstPreview;
      }
      return jsonOk({});
    });

    const card = makeNode('div');
    hooks.renderDetailInto!(card, makeDetail({ canPreview: true }), false);

    const btn = findPreviewBtn(card);
    // First click — starts the preview.
    btn!.dispatchEvent({ type: 'click' });
    // Second click — must be ignored (previewStarting guard).
    btn!.dispatchEvent({ type: 'click' });

    // Resolve the pending fetch so we don't leak timers.
    resolveFirst({ ok: true, status: 'preparing' });
    await flushAsync();

    // Only ONE fetch call should have been made (guard fired on second click).
    const previewFetches = fetchCalls.filter((c) => c.url.includes('/preview'));
    expect(previewFetches).toHaveLength(1);
  });
});

describe('widget.js — ticket activity actor labels', () => {
  it('uses the assigned agent name for nameless agent-authored activity rows', () => {
    const { hooks } = loadWidget(async () => jsonOk({}));
    expect(hooks.renderDetailInto).toBeDefined();

    const card = makeNode('div');
    hooks.renderDetailInto!(
      card,
      makeDetail({
        ticket: {
          ...makeDetail().ticket,
          assignedAgentName: 'Codex Coder',
        },
        activity: [{
          id: 'act-agent-started',
          type: 'comment',
          content: 'Coder session started',
          createdByType: 'agent',
          createdByName: null,
          createdAt: new Date().toISOString(),
          metadata: null,
        }],
      }),
      false,
    );

    const text = card._text();
    expect(text).toContain('Codex Coder');
    expect(text).toContain('Coder session started');
    expect(text).not.toContain('Team');
  });
});
