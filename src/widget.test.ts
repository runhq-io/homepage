import { describe, it, expect } from 'vitest';
import { isBoardRoute, RESERVED_SLUGS } from './widget';

/**
 * `isBoardRoute` decides where the floating RunHQ launcher shows: it must be
 * true for exactly the `/:slug` full-page board route (where BoardPage owns the
 * page's single widget) and false for every marketing page. These are the same
 * routes declared in App.tsx — keep them in lockstep.
 */
describe('isBoardRoute', () => {
  it('is false for the marketing home (launcher shows)', () => {
    expect(isBoardRoute('/')).toBe(false);
    expect(isBoardRoute('')).toBe(false);
  });

  it('is false for every declared top-level marketing route', () => {
    for (const path of [
      '/products', '/pricing', '/docs', '/visual', '/about', '/privacy', '/terms',
    ]) {
      expect(isBoardRoute(path)).toBe(false);
    }
  });

  it('is false for nested marketing routes (e.g. /docs/*)', () => {
    expect(isBoardRoute('/docs/getting-started')).toBe(false);
    expect(isBoardRoute('/docs/a/b')).toBe(false);
  });

  it('is false for every reserved / structural slug', () => {
    for (const slug of RESERVED_SLUGS) {
      expect(isBoardRoute(`/${slug}`)).toBe(false);
    }
  });

  it('is true for a project board slug (launcher stays out)', () => {
    expect(isBoardRoute('/runhq')).toBe(true);
    expect(isBoardRoute('/arrr')).toBe(true);
    expect(isBoardRoute('/some-project')).toBe(true);
  });

  /**
   * `ko` MUST NOT be reserved. `/ko/*` is a legacy redirect onto the unprefixed
   * path, so `/ko/arrr` lands on a board. Reserving `ko` would make this false,
   * the launcher would claim the page's single widget slot during the render
   * before the redirect commits, and the board's own `init()` would be dropped
   * by the widget script's `initInFlight` guard — a blank board with a stray
   * launcher bubble. That shipped once; this is the regression guard.
   */
  it('does not reserve the retired locale prefix', () => {
    expect(RESERVED_SLUGS.has('ko')).toBe(false);
    expect(isBoardRoute('/ko/arrr')).toBe(true);
    expect(isBoardRoute('/ko/arrr/tickets')).toBe(true);
  });

  it('is true for a board tab sub-path (launcher stays out across tab nav)', () => {
    // /:slug/* — the widget owns these segments; the board still owns the page.
    expect(isBoardRoute('/arrr/tickets')).toBe(true);
    expect(isBoardRoute('/arrr/deploys')).toBe(true);
    expect(isBoardRoute('/arrr/my-tickets')).toBe(true);
    expect(isBoardRoute('/arrr/tickets/')).toBe(true);
    // A reserved first segment stays a marketing route even with sub-paths.
    expect(isBoardRoute('/docs/anything')).toBe(false);
  });

  it('is case-insensitive about reserved slugs', () => {
    expect(isBoardRoute('/Products')).toBe(false);
    expect(isBoardRoute('/DOCS')).toBe(false);
    expect(isBoardRoute('/Docs/intro')).toBe(false);
  });

  it('tolerates trailing slashes on a board slug', () => {
    expect(isBoardRoute('/runhq/')).toBe(true);
  });
});
