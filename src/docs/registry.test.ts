import { describe, it, expect } from 'vitest';
import { PAGES, REDIRECTS, GROUP_ORDER } from './registry';

// Page sources (as text) and the screenshot files, resolved by Vite at test time.
const PAGE_SOURCES = import.meta.glob('./pages/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const IMAGES = Object.keys(import.meta.glob('../../public/docs/img/*.webp')).map((p) => p.replace(/^.*\/|\.webp$/g, ''));

/** Every <Shot name="…"> used by the docs pages. */
function shotNames(): string[] {
  const names: string[] = [];
  for (const src of Object.values(PAGE_SOURCES)) {
    for (const m of src.matchAll(/<Shot\s[^>]*?name="([^"]+)"/g)) names.push(m[1]);
  }
  return names;
}

describe('docs registry', () => {
  it('has unique page paths', () => {
    const paths = PAGES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('starts with the docs home and keeps groups together in order', () => {
    expect(PAGES[0].path).toBe('/docs');
    const order = PAGES.map((p) => GROUP_ORDER.indexOf(p.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('has unique section ids within each page', () => {
    for (const p of PAGES) {
      const ids = p.sections.map((s) => s.id);
      expect(new Set(ids).size, p.path).toBe(ids.length);
    }
  });

  it('redirects old paths to pages that exist, never to another redirect', () => {
    const paths = new Set(PAGES.map((p) => p.path));
    for (const [from, to] of Object.entries(REDIRECTS)) {
      expect(paths.has(to), `${from} -> ${to}`).toBe(true);
      expect(paths.has(from), `${from} is both a page and a redirect`).toBe(false);
    }
  });

  it('has an image for every screenshot, and no unused images', () => {
    const used = new Set(shotNames());
    expect(used.size).toBeGreaterThan(0);
    for (const n of used) expect(IMAGES.includes(n), n).toBe(true);
    expect(IMAGES.filter((f) => !used.has(f))).toEqual([]);
  });
});
