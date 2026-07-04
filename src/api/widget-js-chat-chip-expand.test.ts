/**
 * Tests for the chat-composer staged-image chip in the widget (public/widget.js).
 *
 * Covers the fix for "I can't expand the image in the chat page": each pending
 * chat-composer thumbnail must be an interactive control that opens the shared
 * full-screen lightbox on click / Enter / Space, paging through every pending
 * image as a gallery — mirroring the ticket composer's renderAttachChip.
 *
 * Same vm + minimal-DOM-shim harness as widget-js-attach-preview.test.ts,
 * driving the private renderPendingChatChip / pendingChatGallery through the
 * _rwTestHooks sentinel.
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
  const body = makeNode('body');
  return {
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel.includes('widget.js') ? [scriptEl] : []),
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => makeTextNode(text),
    head: makeNode('head'),
    body,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

interface ChatImg { id: string | null; dataUrl: string; name?: string; uploading?: boolean; failed?: boolean }
interface TestHooks {
  renderPendingChatChip?: (entry: ChatImg, onRemove: (e: ChatImg) => void) => FakeNode;
  pendingChatGallery?: () => Array<{ url: string; name: string }>;
  _setPendingChatImages?: (imgs: ChatImg[]) => void;
  _setModalMountEl?: (el: FakeNode) => void;
}

function loadWidget() {
  const source = readFileSync(join(process.cwd(), 'public', 'widget.js'), 'utf8');
  const hooks: TestHooks = {};

  const windowMock: Record<string, unknown> = {
    location: { origin: 'https://customer.test', href: 'https://customer.test/' },
    onerror: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    open: vi.fn(),
    EventSource: undefined,
    _rwTestHooks: hooks,
  };
  const doc = makeDomMock();
  const context: Record<string, unknown> = {
    window: windowMock,
    document: doc,
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
  // Give the shared lightbox somewhere to mount (normally the shadow-DOM modal
  // mount created during full widget mount, which the test harness skips).
  const mount = makeNode('div');
  hooks._setModalMountEl!(mount);
  return { hooks, doc, mount };
}

function hasClass(n: FakeNode, cls: string): boolean {
  return String(n.attrs['class'] || '').split(' ').includes(cls);
}
function findImg(chip: FakeNode): FakeNode | null {
  return chip._find((n) => n.tagName === 'IMG');
}

const IMG_A: ChatImg = { id: 'a', dataUrl: 'data:image/png;base64,AAA', name: 'a.png' };
const IMG_B: ChatImg = { id: 'b', dataUrl: 'data:image/png;base64,BBB', name: 'b.png' };

describe('widget.js — chat composer staged-image chip', () => {
  it('renders an interactive <img> thumbnail (role=button, keyboard-focusable)', () => {
    const { hooks } = loadWidget();
    expect(hooks.renderPendingChatChip).toBeDefined();
    hooks._setPendingChatImages!([IMG_A]);

    const chip = hooks.renderPendingChatChip!(IMG_A, () => {});
    expect(hasClass(chip, 'rw-chat-img-chip')).toBe(true);

    const img = findImg(chip);
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(IMG_A.dataUrl);
    expect(img!.getAttribute('role')).toBe('button');
    expect(img!.getAttribute('tabindex')).toBe('0');
  });

  it('opens the full-screen lightbox when the thumbnail is clicked', () => {
    const { hooks, mount } = loadWidget();
    hooks._setPendingChatImages!([IMG_A]);
    const chip = hooks.renderPendingChatChip!(IMG_A, () => {});

    // No lightbox on screen yet.
    expect(mount._find((n) => hasClass(n, 'rw-lightbox-scrim'))).toBeNull();

    findImg(chip)!.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} });

    // The shared lightbox scrim is mounted, showing this image.
    const scrim = mount._find((n) => hasClass(n, 'rw-lightbox-scrim'));
    expect(scrim).not.toBeNull();
    const lbImg = scrim!._find((n) => hasClass(n, 'rw-lightbox-img'));
    expect(lbImg!.getAttribute('src')).toBe(IMG_A.dataUrl);
  });

  it('opens the lightbox on Enter / Space keydown too', () => {
    const { hooks, mount } = loadWidget();
    hooks._setPendingChatImages!([IMG_A]);
    const chip = hooks.renderPendingChatChip!(IMG_A, () => {});

    findImg(chip)!.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} });
    expect(mount._find((n) => hasClass(n, 'rw-lightbox-scrim'))).not.toBeNull();
  });

  it('opens the lightbox at the clicked image within the full pending gallery', () => {
    const { hooks, mount } = loadWidget();
    hooks._setPendingChatImages!([IMG_A, IMG_B]);
    const chip = hooks.renderPendingChatChip!(IMG_B, () => {});

    findImg(chip)!.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} });

    const scrim = mount._find((n) => hasClass(n, 'rw-lightbox-scrim'));
    const lbImg = scrim!._find((n) => hasClass(n, 'rw-lightbox-img'));
    // Started at IMG_B (the clicked one), not the first image.
    expect(lbImg!.getAttribute('src')).toBe(IMG_B.dataUrl);
    // Gallery has both, so a prev arrow back to IMG_A is available.
    const prev = scrim!._find((n) => hasClass(n, 'rw-lightbox-prev'));
    expect(prev!.style.display).toBe('inline-flex');
  });

  it('invokes onRemove(entry) when the chip × is clicked', () => {
    const { hooks } = loadWidget();
    hooks._setPendingChatImages!([IMG_A]);
    const onRemove = vi.fn();
    const chip = hooks.renderPendingChatChip!(IMG_A, onRemove);

    const x = chip._find((n) => n.tagName === 'BUTTON' && hasClass(n, 'rw-chat-img-chip-x'));
    expect(x).not.toBeNull();
    x!.dispatchEvent({ type: 'click' });
    expect(onRemove).toHaveBeenCalledWith(IMG_A);
  });

  it('pendingChatGallery lists only preview-ready images, in order', () => {
    const { hooks } = loadWidget();
    hooks._setPendingChatImages!([
      IMG_A,
      { id: null, dataUrl: '', name: 'uploading.png', uploading: true }, // no preview yet → skipped
      IMG_B,
    ]);
    expect(hooks.pendingChatGallery!()).toEqual([
      { url: IMG_A.dataUrl, name: 'a.png' },
      { url: IMG_B.dataUrl, name: 'b.png' },
    ]);
  });
});
