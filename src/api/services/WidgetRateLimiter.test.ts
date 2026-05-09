import { describe, it, expect, beforeEach } from 'vitest';
import { WidgetRateLimiter } from './WidgetRateLimiter';

describe('WidgetRateLimiter', () => {
  let now = 1_000_000;
  let limiter: WidgetRateLimiter;

  beforeEach(() => {
    now = 1_000_000;
    limiter = new WidgetRateLimiter({ now: () => now });
  });

  it('allows up to N requests per hour', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('proj_a', 'user_1', 5)).toEqual({ allowed: true, retryAfterSec: 0 });
    }
    const denied = limiter.check('proj_a', 'user_1', 5);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it('isolates buckets by (project, user)', () => {
    for (let i = 0; i < 5; i++) limiter.check('proj_a', 'user_1', 5);
    expect(limiter.check('proj_a', 'user_2', 5).allowed).toBe(true);
    expect(limiter.check('proj_b', 'user_1', 5).allowed).toBe(true);
  });

  it('expires entries after the window slides past', () => {
    for (let i = 0; i < 5; i++) limiter.check('proj_a', 'user_1', 5);
    expect(limiter.check('proj_a', 'user_1', 5).allowed).toBe(false);
    now += 3_600_001;
    expect(limiter.check('proj_a', 'user_1', 5).allowed).toBe(true);
  });

  it('reports retry-after as seconds until oldest entry expires', () => {
    for (let i = 0; i < 5; i++) limiter.check('proj_a', 'user_1', 5);
    now += 1_000;
    const r = limiter.check('proj_a', 'user_1', 5);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBe(3599);
  });
});
