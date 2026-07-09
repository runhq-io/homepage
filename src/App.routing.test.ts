import { describe, it, expect } from 'vitest';
import { matchRoutes } from 'react-router-dom';

/**
 * Guards the react-router assumptions App.tsx depends on, so a router upgrade or
 * an accidental route edit can't silently break board URLs:
 *   1. The trailing splat still captures `:slug` — BoardPage reads useParams().slug,
 *      so `/arrr/tickets` must resolve slug === 'arrr' (not 'arrr/tickets').
 *   2. A declared static marketing route still wins over the catch-all `/:slug/*`.
 *   3. Legacy `/ko/*` URLs still hit the redirect, not the board catch-all.
 *
 * These paths mirror App.tsx — keep them in lockstep with the <Routes> there.
 */
const ROUTES = [
  { path: '/' },
  { path: '/pricing' },
  { path: '/docs/*' },
  { path: '/ko/*' },
  { path: '/:slug/*' },
];

const matched = (path: string) => {
  const m = matchRoutes(ROUTES, path);
  expect(m).not.toBeNull();
  return m![m!.length - 1];
};

describe('App routing — board sub-paths', () => {
  it('mounts the board (/:slug/*) for a tab sub-path with slug captured', () => {
    const last = matched('/arrr/tickets');
    expect(last.route.path).toBe('/:slug/*');
    expect(last.params.slug).toBe('arrr');
    expect(last.params['*']).toBe('tickets');
  });

  it('mounts the board for the bare /:slug too', () => {
    const last = matched('/arrr');
    expect(last.route.path).toBe('/:slug/*');
    expect(last.params.slug).toBe('arrr');
  });

  it('lets a declared marketing route win over the catch-all', () => {
    expect(matchRoutes(ROUTES, '/pricing')![0].route.path).toBe('/pricing');
    expect(matched('/docs/getting-started').route.path).toBe('/docs/*');
  });
});

/**
 * The locale prefix is retired. `/ko/*` is a legacy redirect and nothing else —
 * it must never fall through to `/:slug/*`, where slug would be `ko` and the
 * board would render a 404. That was the original bug.
 */
describe('App routing — legacy /ko/* redirect', () => {
  it('routes every /ko/... path to the redirect, never to the board catch-all', () => {
    for (const path of ['/ko', '/ko/arrr', '/ko/arrr/tickets', '/ko/pricing', '/ko/docs/intro']) {
      const last = matched(path);
      expect(last.route.path).toBe('/ko/*');
      expect(last.params.slug).toBeUndefined();
    }
  });

  it('captures the remainder so the redirect can rebuild the unprefixed path', () => {
    expect(matched('/ko').params['*']).toBe('');
    expect(matched('/ko/pricing').params['*']).toBe('pricing');
    expect(matched('/ko/arrr/tickets').params['*']).toBe('arrr/tickets');
  });

  it('matches by segment, not string prefix — /kombucha is still a board', () => {
    const last = matched('/kombucha');
    expect(last.route.path).toBe('/:slug/*');
    expect(last.params.slug).toBe('kombucha');
  });

  /**
   * Route matching is case-insensitive by default, so `/KO/arrr` also redirects
   * rather than resolving to a board with slug `KO`. Pinned because `isBoardRoute`
   * lowercases its segment and the two must agree — if the router ever became
   * case-sensitive, `/KO/arrr` would hit the catch-all and 404.
   */
  it('redirects a differently-cased legacy prefix too', () => {
    expect(matched('/KO/arrr').route.path).toBe('/ko/*');
    expect(matched('/Ko/pricing').route.path).toBe('/ko/*');
  });
});
