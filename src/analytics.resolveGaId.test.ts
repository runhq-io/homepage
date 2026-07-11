import { describe, it, expect } from 'vitest';
import { resolveGaId, PRODUCTION_GA_ID, GA_DISABLED } from './analytics';

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

  /**
   * Staging pollution guard. A staging build is still a *production-mode* vite
   * build, so `isProd` is true there — leaving the var empty would hand staging
   * the production property and mix staging traffic into real data. The explicit
   * `none` sentinel is what distinguishes "deliberately no analytics" from
   * "somebody forgot to set it" (which must still fall back, per the tests above).
   */
  it('honors the explicit `none` opt-out even in a production build (staging)', () => {
    expect(resolveGaId(GA_DISABLED, true)).toBeUndefined();
    expect(resolveGaId('none', true)).toBeUndefined();
    expect(resolveGaId('NONE', true)).toBeUndefined();
    expect(resolveGaId('  none  ', true)).toBeUndefined();
  });

  it('does not confuse the opt-out with a forgotten value', () => {
    // Forgotten -> still falls back (never black out prod again).
    expect(resolveGaId('', true)).toBe(PRODUCTION_GA_ID);
    // Deliberate -> off.
    expect(resolveGaId(GA_DISABLED, true)).toBeUndefined();
  });
});
