import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureVisitorId, readVisitorId, SDK_ANON_KEY, trackingSuppressed } from './visitorId';

/**
 * R114d: a consented visitor's arm is computed from the SDK's own visitor id,
 * read from the SDK's own storage — and, when there is none yet, minted here
 * and stored under the SDK's key, so the SDK adopts it (widget.js
 * `trackResolveAnonId` reads localStorage, then the cookie mirror).
 */

function browser(o: { local?: Record<string, string>; cookie?: string; host?: string; blockStorage?: boolean } = {}) {
  const local: Record<string, string> = { ...(o.local ?? {}) };
  const cookies: string[] = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => { if (o.blockStorage) throw new Error('blocked'); return local[k] ?? null; },
    setItem: (k: string, v: string) => { if (o.blockStorage) throw new Error('blocked'); local[k] = v; },
  });
  vi.stubGlobal('document', {
    get cookie() { return o.cookie ?? ''; },
    set cookie(v: string) { cookies.push(v); },
  });
  vi.stubGlobal('window', { location: { hostname: o.host ?? 'www.runhq.io' } });
  return { local, cookies };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('readVisitorId', () => {
  it('reads the SDK’s key from localStorage, then its cookie mirror', () => {
    browser({ local: { [SDK_ANON_KEY]: 'from-storage' }, cookie: 'rw_anon_id=from-cookie' });
    expect(readVisitorId()).toBe('from-storage');
    browser({ cookie: 'a=1; rw_anon_id=from%2Dcookie' });
    expect(readVisitorId()).toBe('from-cookie');
    browser();
    expect(readVisitorId()).toBeNull();
  });
});

describe('ensureVisitorId', () => {
  it('returns the id the SDK already holds, and writes it back like the SDK does', () => {
    const b = browser({ cookie: 'rw_anon_id=existing' });
    expect(ensureVisitorId()).toBe('existing');
    expect(b.local[SDK_ANON_KEY]).toBe('existing');
  });

  it('mints an id in the SDK’s format and stores it where the SDK will find it', () => {
    const b = browser();
    const id = ensureVisitorId()!;
    expect(id).toMatch(/^[a-z0-9]{22}$/);
    expect(b.local[SDK_ANON_KEY]).toBe(id);
    // The registrable-domain mirror the SDK writes, so www → app is one visitor.
    expect(b.cookies[0]).toBe(`rw_anon_id=${id};path=/;max-age=63072000;domain=.runhq.io;SameSite=Lax`);
    expect(ensureVisitorId()).toBe(id);
  });

  it('answers null when storage cannot keep an id: an arm painted for it could never be counted', () => {
    browser({ blockStorage: true });
    expect(ensureVisitorId()).toBeNull();
  });
});

describe('trackingSuppressed', () => {
  it('follows the SDK’s own suppression latch', () => {
    browser({ local: { rw_track_off_until: String(Date.now() + 60_000) } });
    expect(trackingSuppressed()).toBe(true);
    browser({ local: { rw_track_off_until: String(Date.now() - 1) } });
    expect(trackingSuppressed()).toBe(false);
    browser();
    expect(trackingSuppressed()).toBe(false);
  });
});
