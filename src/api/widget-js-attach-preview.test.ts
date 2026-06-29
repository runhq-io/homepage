/**
 * Tests for the staged-attachment preview chip in the widget composers.
 *
 * The widget UI lives in public/widget.js (vanilla JS IIFE). We load it via
 * vm.runInNewContext with a minimal DOM shim (no jsdom) and a mock object-URL
 * factory, then drive the private `renderAttachChip` / `releaseAttachPreview`
 * functions exposed through the `_rwTestHooks` sentinel.
 *
 * Covers the fix for "attached images don't show in the widget":
 *  - An image attachment renders an inline <img.rw-chip-thumb> thumbnail whose
 *    src is the object URL minted over the chosen bytes (not just a filename).
 *  - A non-image attachment falls back to the icon — no thumbnail.
 *  - Re-rendering the same entry reuses one object URL (no per-render leak).
 *  - Clicking the chip's × invokes onRemove(entry).
 *  - releaseAttachPreview revokes the object URL and clears the cache.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Minimal DOM shim — enough for h()/renderAttachChip (create/append/attr/event).
// ---------------------------------------------------------------------------

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

interface ChipEntry { file: { name?: string; type?: string }; previewUrl?: string | null }
interface TestHooks {
  renderAttachChip?: (entry: ChipEntry, onRemove: (e: ChipEntry) => void) => FakeNode;
  releaseAttachPreview?: (entry: ChipEntry) => void;
}

function loadWidget() {
  const source = readFileSync(join(process.cwd(), 'public', 'widget.js'), 'utf8');
  const hooks: TestHooks = {};

  let seq = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const objectUrlFactory = {
    createObjectURL: vi.fn((_file: unknown) => {
      const url = `blob:mock/${seq++}`;
      created.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => { revoked.push(url); }),
  };
  // The widget references the global `URL`. Extend Node's URL so existing URL
  // parsing still works, and bolt on the object-URL factory the preview uses.
  class UrlWithBlob extends URL {
    static createObjectURL = objectUrlFactory.createObjectURL;
    static revokeObjectURL = objectUrlFactory.revokeObjectURL;
  }

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
    URL: UrlWithBlob,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
    btoa: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
  };

  vm.runInNewContext(source, context);
  return { hooks, created, revoked, objectUrlFactory };
}

function hasClass(n: FakeNode, cls: string): boolean {
  return String(n.attrs['class'] || '').split(' ').includes(cls);
}
function findThumb(chip: FakeNode): FakeNode | null {
  return chip._find((n) => n.tagName === 'IMG' && hasClass(n, 'rw-chip-thumb-img'));
}
function anyTextContains(n: FakeNode, s: string): boolean {
  if (typeof n.textContent === 'string' && n.textContent.includes(s)) return true;
  return n.children.some((c) => anyTextContains(c, s));
}

describe('widget.js — staged attachment preview chip', () => {
  it('renders a standalone image thumbnail (no filename) for an image attachment', () => {
    const { hooks, created, objectUrlFactory } = loadWidget();
    expect(hooks.renderAttachChip).toBeDefined();

    const entry: ChipEntry = { file: { name: 'shot.png', type: 'image/png' } };
    const chip = hooks.renderAttachChip!(entry, () => {});

    // The chip is a thumbnail tile embedding a real <img> preview.
    expect(hasClass(chip, 'rw-chip-thumb')).toBe(true);
    const thumb = findThumb(chip);
    expect(thumb).not.toBeNull();
    // Its src is the object URL minted over the chosen file bytes.
    expect(objectUrlFactory.createObjectURL).toHaveBeenCalledWith(entry.file);
    expect(thumb!.getAttribute('src')).toBe(created[0]);
    expect(entry.previewUrl).toBe(created[0]);
    // The thumbnail is an interactive control (click → full-screen lightbox).
    expect(thumb!.getAttribute('role')).toBe('button');
    // The filename is NOT rendered as visible text anywhere in the chip.
    expect(anyTextContains(chip, 'shot.png')).toBe(false);
  });

  it('falls back to an icon (no thumbnail) for a non-image attachment', () => {
    const { hooks, objectUrlFactory } = loadWidget();
    const entry: ChipEntry = { file: { name: 'notes.pdf', type: 'application/pdf' } };
    const chip = hooks.renderAttachChip!(entry, () => {});

    expect(hasClass(chip, 'rw-chip-thumb')).toBe(false);
    expect(findThumb(chip)).toBeNull();
    expect(objectUrlFactory.createObjectURL).not.toHaveBeenCalled();
    expect(entry.previewUrl).toBeUndefined();
  });

  it('reuses one object URL across re-renders of the same entry', () => {
    const { hooks, objectUrlFactory } = loadWidget();
    const entry: ChipEntry = { file: { name: 'shot.png', type: 'image/png' } };

    hooks.renderAttachChip!(entry, () => {});
    hooks.renderAttachChip!(entry, () => {});
    hooks.renderAttachChip!(entry, () => {});

    expect(objectUrlFactory.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('invokes onRemove(entry) when the chip × is clicked', () => {
    const { hooks } = loadWidget();
    const entry: ChipEntry = { file: { name: 'shot.png', type: 'image/png' } };
    const onRemove = vi.fn();
    const chip = hooks.renderAttachChip!(entry, onRemove);

    const x = chip._find((n) => n.tagName === 'BUTTON' && hasClass(n, 'rw-chip-x'));
    expect(x).not.toBeNull();
    x!.dispatchEvent({ type: 'click', stopPropagation: () => {} });

    expect(onRemove).toHaveBeenCalledWith(entry);
  });

  it('releaseAttachPreview revokes the object URL and clears the cache', () => {
    const { hooks, created, revoked } = loadWidget();
    const entry: ChipEntry = { file: { name: 'shot.png', type: 'image/png' } };
    hooks.renderAttachChip!(entry, () => {});
    expect(entry.previewUrl).toBe(created[0]);

    hooks.releaseAttachPreview!(entry);
    expect(revoked).toContain(created[0]);
    expect(entry.previewUrl).toBeNull();
  });
});
