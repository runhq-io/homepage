import { describe, it, expect } from 'vitest';
import { consentModeCommands, PRODUCTION_GA_ID } from './analytics';

/**
 * Consent Mode v2 lives or dies on the ORDER of the gtag queue. If `config` is
 * queued before `consent default`, gtag.js has already decided it may use
 * storage, and the "cookieless ping" property we rely on is gone.
 *
 * The behaviour these lock in is what fixes the measurement blackout: GA boots
 * for EVERY visitor with storage denied, so a visitor who lands and bounces is
 * still counted (cookielessly) instead of being counted as zero, which is what
 * the old activate-only-after-opt-in design did to a 200k-impression traffic
 * spike.
 */
const name = (c: unknown[]) => `${c[0]}${c[1] ? `:${c[1]}` : ''}`;

describe('consentModeCommands', () => {
  it('denies all storage by default, before config — the cookieless-ping contract', () => {
    const cmds = consentModeCommands(PRODUCTION_GA_ID, null);

    // consent:default must be first, and must deny everything.
    expect(name(cmds[0])).toBe('consent:default');
    expect(cmds[0][2]).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });

    // ...and it must be queued strictly before config.
    const defaultIdx = cmds.findIndex((c) => name(c) === 'consent:default');
    const configIdx = cmds.findIndex((c) => c[0] === 'config');
    expect(defaultIdx).toBeLessThan(configIdx);
  });

  it('still boots GA (js + config) when the visitor has not consented', () => {
    const cmds = consentModeCommands(PRODUCTION_GA_ID, null);
    expect(cmds.some((c) => c[0] === 'js')).toBe(true);
    expect(cmds.find((c) => c[0] === 'config')?.[1]).toBe(PRODUCTION_GA_ID);
    // No grant anywhere — an undecided visitor stays cookieless.
    expect(cmds.some((c) => name(c) === 'consent:update')).toBe(false);
  });

  it('upgrades a returning consenter to granted BEFORE the first config', () => {
    const cmds = consentModeCommands(PRODUCTION_GA_ID, 'granted');
    const updateIdx = cmds.findIndex((c) => name(c) === 'consent:update');
    const configIdx = cmds.findIndex((c) => c[0] === 'config');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(cmds[updateIdx][2]).toEqual({ analytics_storage: 'granted' });
    // Otherwise their first page_view of the session would be a cookieless ping.
    expect(updateIdx).toBeLessThan(configIdx);
  });

  it('leaves a returning decliner denied (no grant queued)', () => {
    const cmds = consentModeCommands(PRODUCTION_GA_ID, 'denied');
    expect(cmds.some((c) => name(c) === 'consent:update')).toBe(false);
    // But GA still boots — they are measured cookielessly, not dropped.
    expect(cmds.some((c) => c[0] === 'config')).toBe(true);
  });
});
