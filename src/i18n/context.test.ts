import { describe, it, expect } from 'vitest';
import { isLocalizablePath, pathForLocale, localeFromPath } from './context';

/**
 * The `/ko` prefix belongs to the marketing site only. The full-page widget
 * board (`/:slug`) has no Korean twin, so nothing may move a board URL under
 * `/ko` — doing so made the router resolve slug `ko` and render a 404, which is
 * how a shared `www.runhq.io/arrr` link broke for every Korean-language browser
 * while working for everyone else.
 */
describe('isLocalizablePath', () => {
  it('is true for the marketing routes that have a Korean twin', () => {
    for (const path of [
      '/', '/products', '/pricing', '/docs', '/docs/getting-started',
      '/visual', '/about', '/privacy', '/terms',
    ]) {
      expect(isLocalizablePath(path)).toBe(true);
    }
  });

  it('is false for a full-page board and its per-tab sub-paths', () => {
    expect(isLocalizablePath('/arrr')).toBe(false);
    expect(isLocalizablePath('/arrr/tickets')).toBe(false);
    expect(isLocalizablePath('/runhq/deploys')).toBe(false);
  });
});

describe('pathForLocale', () => {
  it('prefixes marketing paths when switching to Korean', () => {
    expect(pathForLocale('/', 'ko')).toBe('/ko');
    expect(pathForLocale('/pricing', 'ko')).toBe('/ko/pricing');
    expect(pathForLocale('/docs/getting-started', 'ko')).toBe('/ko/docs/getting-started');
  });

  it('strips the prefix when switching back to English', () => {
    expect(pathForLocale('/ko', 'en')).toBe('/');
    expect(pathForLocale('/ko/pricing', 'en')).toBe('/pricing');
  });

  it('leaves a board path alone in BOTH directions — a board has no /ko twin', () => {
    expect(pathForLocale('/arrr', 'ko')).toBe('/arrr');
    expect(pathForLocale('/arrr/tickets', 'ko')).toBe('/arrr/tickets');
    expect(pathForLocale('/arrr', 'en')).toBe('/arrr');
  });

  it('is idempotent for a board path, so no redirect loop is possible', () => {
    expect(pathForLocale(pathForLocale('/arrr', 'ko'), 'ko')).toBe('/arrr');
  });
});

describe('localeFromPath', () => {
  it('reads the locale off the prefix, not off a board slug', () => {
    expect(localeFromPath('/ko')).toBe('ko');
    expect(localeFromPath('/ko/pricing')).toBe('ko');
    expect(localeFromPath('/')).toBe('en');
    expect(localeFromPath('/arrr')).toBe('en');
  });
});
