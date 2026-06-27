import { describe, it, expect } from 'vitest';
import {
  PLAN_CONFIG,
  UNLIMITED_SERVERS,
  FREE_PLAN_TIER,
  hasReachedServerLimit,
  isUnlimitedServers,
  isTierAllowedForPlan,
  enforcesPlanLimits,
} from './UsageService';

describe('plan server-limit helpers', () => {
  it('treats free plan as a hard cap of 1 server', () => {
    expect(PLAN_CONFIG.free.maxServers).toBe(1);
    expect(hasReachedServerLimit(0, PLAN_CONFIG.free.maxServers)).toBe(false);
    expect(hasReachedServerLimit(1, PLAN_CONFIG.free.maxServers)).toBe(true);
    expect(hasReachedServerLimit(5, PLAN_CONFIG.free.maxServers)).toBe(true);
  });

  it.each(['starter', 'pro', 'team'] as const)('treats %s plan as unlimited', (planId) => {
    const plan = PLAN_CONFIG[planId];
    expect(plan.maxServers).toBe(UNLIMITED_SERVERS);
    expect(isUnlimitedServers(plan.maxServers)).toBe(true);
    expect(hasReachedServerLimit(0, plan.maxServers)).toBe(false);
    expect(hasReachedServerLimit(50, plan.maxServers)).toBe(false);
    expect(hasReachedServerLimit(10_000, plan.maxServers)).toBe(false);
  });

  it('json-serializes the unlimited sentinel safely', () => {
    const payload = { maxServers: PLAN_CONFIG.pro.maxServers };
    const json = JSON.parse(JSON.stringify(payload));
    expect(json.maxServers).toBe(UNLIMITED_SERVERS);
  });
});

describe('isTierAllowedForPlan', () => {
  it('restricts free users to the lowest tier', () => {
    expect(FREE_PLAN_TIER).toBe('shared-4x-4gb');
    expect(isTierAllowedForPlan('free', FREE_PLAN_TIER)).toBe(true);
    expect(isTierAllowedForPlan('free', 'shared-8x-8gb')).toBe(false);
    expect(isTierAllowedForPlan('free', 'perf-2x-8gb')).toBe(false);
  });

  it.each(['starter', 'pro', 'team'] as const)('allows any tier on %s', (planId) => {
    expect(isTierAllowedForPlan(planId, 'shared-4x-1gb')).toBe(true);
    expect(isTierAllowedForPlan(planId, 'shared-4x-4gb')).toBe(true);
    expect(isTierAllowedForPlan(planId, 'perf-4x-16gb')).toBe(true);
  });
});

describe('enforcesPlanLimits', () => {
  it('enforces plan limits on the fly provider (paid infrastructure)', () => {
    expect(enforcesPlanLimits('fly')).toBe(true);
  });

  it('exempts the docker provider (no usage cost; local dev)', () => {
    expect(enforcesPlanLimits('docker')).toBe(false);
  });
});
