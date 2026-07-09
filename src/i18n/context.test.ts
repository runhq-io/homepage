import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectLocale, readStoredLocale, LOCALE_KEY } from './context';

/**
 * Locale is a stored user preference, not a URL segment. Nothing here may look at
 * `location`: a path prefix is what put locales in the same namespace as project
 * slugs, so `/ko` was ambiguous with a board named `ko` and shared board links
 * 404'd for Korean browsers.
 *
 * Tests run in vitest's node environment, which has no `localStorage`, so we
 * install a real in-memory Storage — the code under test is exercised unchanged.
 */
function installStorage(impl?: Partial<Storage>) {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
    ...impl,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  return store;
}

describe('detectLocale', () => {
  beforeEach(() => {
    installStorage();
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('falls back to the browser language when nothing is stored', () => {
    expect(detectLocale('ko-KR')).toBe('ko');
    expect(detectLocale('ko')).toBe('ko');
    expect(detectLocale('KO-kr')).toBe('ko');
    expect(detectLocale('en-US')).toBe('en');
    expect(detectLocale('fr')).toBe('en');
    expect(detectLocale('')).toBe('en');
    expect(detectLocale()).toBe('en');
  });

  it('lets an explicit stored preference beat the browser language', () => {
    localStorage.setItem(LOCALE_KEY, 'en');
    expect(detectLocale('ko-KR')).toBe('en');
    localStorage.setItem(LOCALE_KEY, 'ko');
    expect(detectLocale('en-US')).toBe('ko');
  });

  it('ignores a garbage stored value rather than trusting it', () => {
    localStorage.setItem(LOCALE_KEY, 'klingon');
    expect(readStoredLocale()).toBeNull();
    expect(detectLocale('ko-KR')).toBe('ko');
    expect(detectLocale('en-US')).toBe('en');
  });

  it('survives localStorage throwing (private mode) instead of blanking the page', () => {
    installStorage({
      getItem: () => {
        throw new Error('access denied');
      },
    });
    expect(readStoredLocale()).toBeNull();
    expect(detectLocale('ko-KR')).toBe('ko');
    expect(detectLocale('en-US')).toBe('en');
  });

  it('survives localStorage being absent entirely', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(readStoredLocale()).toBeNull();
    expect(detectLocale('ko-KR')).toBe('ko');
  });
});
