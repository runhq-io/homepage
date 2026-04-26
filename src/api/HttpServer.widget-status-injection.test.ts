import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { TODO_STATUS_DISPLAY, TODO_STATUS_ORDER, type TodoStatus, type TodoStatusDisplay } from '@runhq/server-protocol';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(),
}));
vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class {
    isConfigured() { return false; }
  },
}));

import { createHttpApp } from './HttpServer';

describe('TODO_STATUS_DISPLAY (protocol registry)', () => {
  it('has an entry for every TodoStatus value', () => {
    for (const status of TODO_STATUS_ORDER) {
      expect(TODO_STATUS_DISPLAY[status], `missing entry for status: ${status}`).toBeDefined();
    }
  });

  it('every entry has a non-empty label and visual fields', () => {
    for (const status of TODO_STATUS_ORDER) {
      const entry: TodoStatusDisplay = TODO_STATUS_DISPLAY[status];
      expect(entry.label, `${status}.label must be non-empty`).toMatch(/\S/);
      expect(entry.dot, `${status}.dot must be a hex color`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      expect(entry.bg, `${status}.bg must be an rgba/rgb color`).toMatch(/^rgba?\(/);
      expect(entry.fg, `${status}.fg must be a hex color`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  });

  it('uses RunHQ canonical labels (no widget-only synonyms like "Open"/"Shipped")', () => {
    // The widget previously relabeled pending→"Open" and done→"Shipped",
    // creating divergence from RunHQ's canonical vocabulary. Pin the names.
    expect(TODO_STATUS_DISPLAY.pending.label).toBe('Pending');
    expect(TODO_STATUS_DISPLAY.done.label).toBe('Done');
    expect(TODO_STATUS_DISPLAY.deployed.label).toBe('Deployed');
  });

  it('has distinct dot colors per status (visual differentiation)', () => {
    const dots = TODO_STATUS_ORDER.map((s) => TODO_STATUS_DISPLAY[s].dot);
    expect(new Set(dots).size, 'every status must have a distinct dot color').toBe(dots.length);
  });
});

describe('GET /widget.js — status registry injection', () => {
  async function fetchWidgetBody(): Promise<string> {
    const app = createHttpApp();
    const res = await app.request('http://localhost/widget.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript');
    return await res.text();
  }

  it('prepends a window.__RW_CONSTANTS__ initializer block', async () => {
    const body = await fetchWidgetBody();
    expect(body).toMatch(/window\.__RW_CONSTANTS__/);
    expect(body.indexOf('window.__RW_CONSTANTS__')).toBeLessThan(body.indexOf('RunHQ Widget v'));
  });

  it('embeds every TodoStatus display entry into the served body', async () => {
    const body = await fetchWidgetBody();
    for (const status of TODO_STATUS_ORDER) {
      const entry = TODO_STATUS_DISPLAY[status];
      // Status key appears in the JSON literal
      expect(body, `served widget body missing status key: ${status}`).toContain(`"${status}"`);
      // Label appears verbatim — proves the registry is live, not stubbed
      expect(body, `served widget body missing label for ${status}: ${entry.label}`).toContain(entry.label);
    }
  });

  it('does not contain a widget-side hardcoded STATUS literal', () => {
    // The static widget.js source must not redefine the registry.
    // Guard against future regressions where someone re-adds a STATUS map.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const widgetSource = fs.readFileSync(path.join(process.cwd(), 'public', 'widget.js'), 'utf-8');
    expect(widgetSource).not.toMatch(/var\s+STATUS\s*=\s*\{/);
    expect(widgetSource).toMatch(/window\.__RW_CONSTANTS__/);
  });

  it('serves the JSON registry as valid parseable JSON', async () => {
    const body = await fetchWidgetBody();
    // Extract the JSON literal from the injected payload — it follows `var p=`
    const m = body.match(/var p=(\{.*?\});for\(var k in p\)/);
    expect(m, 'injected payload should contain a JSON literal').not.toBeNull();
    const parsed = JSON.parse(m![1]) as { status: Record<TodoStatus, TodoStatusDisplay> };
    for (const status of TODO_STATUS_ORDER) {
      expect(parsed.status[status]).toEqual(TODO_STATUS_DISPLAY[status]);
    }
  });
});
