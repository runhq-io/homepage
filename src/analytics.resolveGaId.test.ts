import { describe, it, expect } from 'vitest';
import { resolveGaId, PRODUCTION_GA_ID } from './analytics';

/**
 * Regression guard for the analytics blackout: the 2026-07-05 consent refactor
 * made the GA4 Measurement ID come solely from VITE_GA_ID, and that CI secret
 * was never set — so every production build shipped with GA_ID === undefined,
 * `analyticsEnabled()` false, and gtag.js dead-code-eliminated. Thousands of
 * www.runhq.io/:slug board visitors were captured as zero.
 *
 * resolveGaId() must therefore keep production analytics alive even when the env
 * var is missing, while never enabling it for local dev / tests by accident.
 */
describe('resolveGaId', () => {
  it('uses an explicit VITE_GA_ID in any environment (per-env override)', () => {
    expect(resolveGaId('G-STAGING01', true)).toBe('G-STAGING01');
    expect(resolveGaId('G-STAGING01', false)).toBe('G-STAGING01');
  });

  it('falls back to the production property in a production build when unset/empty', () => {
    expect(resolveGaId(undefined, true)).toBe(PRODUCTION_GA_ID);
    expect(resolveGaId('', true)).toBe(PRODUCTION_GA_ID);
  });

  it('stays disabled in non-production builds when unset (no dev/test pollution)', () => {
    expect(resolveGaId(undefined, false)).toBeUndefined();
    expect(resolveGaId('', false)).toBeUndefined();
  });
});
