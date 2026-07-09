import { describe, it, expect } from 'vitest';
import { matchRoutes } from 'react-router-dom';

/**
 * Guards the two react-router assumptions the `/:slug/*` board route in App.tsx
 * depends on, so a router upgrade or an accidental route edit can't silently
 * break per-tab board URLs (www.runhq.io/arrr/tickets):
 *   1. The trailing splat still captures `:slug` — BoardPage reads useParams().slug,
 *      so `/arrr/tickets` must resolve slug === 'arrr' (not 'arrr/tickets').
 *   2. A declared static marketing route still wins over the catch-all `/:slug/*`.
 *
 * These paths mirror App.tsx — keep them in lockstep with the <Routes> there.
 */
const ROUTES = [
  { path: '/' },
  { path: '/pricing' },
  { path: '/docs/*' },
  { path: '/ko' },
  { path: '/ko/pricing' },
  { path: '/ko/docs/*' },
  { path: '/ko/:slug/*' },
  { path: '/:slug/*' },
];

describe('App routing — board sub-paths', () => {
  it('mounts the board (/:slug/*) for a tab sub-path with slug captured', () => {
    const m = matchRoutes(ROUTES, '/arrr/tickets');
    expect(m).not.toBeNull();
    const last = m![m!.length - 1];
    expect(last.route.path).toBe('/:slug/*');
    expect(last.params.slug).toBe('arrr');
    expect(last.params['*']).toBe('tickets');
  });

  it('mounts the board for the bare /:slug too', () => {
    const m = matchRoutes(ROUTES, '/arrr');
    expect(m![m!.length - 1].route.path).toBe('/:slug/*');
    expect(m![m!.length - 1].params.slug).toBe('arrr');
  });

  it('lets a declared marketing route win over the catch-all', () => {
    expect(matchRoutes(ROUTES, '/pricing')![0].route.path).toBe('/pricing');
    // A reserved section with its own splat route also wins.
    const docs = matchRoutes(ROUTES, '/docs/getting-started');
    expect(docs![docs!.length - 1].route.path).toBe('/docs/*');
  });
});

/**
 * `/ko/<slug>` board URLs exist in the wild (the locale auto-detector used to
 * rewrite every path for Korean browsers). They must route to the repair hatch,
 * NOT to the `/:slug/*` catch-all with slug === 'ko' — that is the 404 the bug
 * produced.
 */
describe('App routing — locale-prefixed board URLs', () => {
  it('routes /ko/<slug> to the redirect, capturing the real slug', () => {
    const m = matchRoutes(ROUTES, '/ko/arrr');
    const last = m![m!.length - 1];
    expect(last.route.path).toBe('/ko/:slug/*');
    expect(last.params.slug).toBe('arrr');
  });

  it('routes /ko/<slug>/<tab> to the redirect, keeping the tab as the splat', () => {
    const m = matchRoutes(ROUTES, '/ko/arrr/tickets');
    const last = m![m!.length - 1];
    expect(last.route.path).toBe('/ko/:slug/*');
    expect(last.params.slug).toBe('arrr');
    expect(last.params['*']).toBe('tickets');
  });

  it('never resolves a /ko/... path to the board catch-all with slug "ko"', () => {
    for (const path of ['/ko/arrr', '/ko/arrr/tickets', '/ko/pricing', '/ko/docs/intro']) {
      const m = matchRoutes(ROUTES, path)!;
      expect(m[m.length - 1].params.slug).not.toBe('ko');
    }
  });

  it('still serves the declared Korean marketing routes ahead of the redirect', () => {
    expect(matchRoutes(ROUTES, '/ko')![0].route.path).toBe('/ko');
    const pricing = matchRoutes(ROUTES, '/ko/pricing')!;
    expect(pricing[pricing.length - 1].route.path).toBe('/ko/pricing');
    const docs = matchRoutes(ROUTES, '/ko/docs/intro')!;
    expect(docs[docs.length - 1].route.path).toBe('/ko/docs/*');
  });
});
