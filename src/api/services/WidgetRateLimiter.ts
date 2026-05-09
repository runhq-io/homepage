/**
 * In-memory sliding-window rate limiter for widget triager assignments.
 *
 * Buckets are keyed by (widgetProjectId, widgetUserId). Each bucket stores
 * recent timestamps; on `check`, expired timestamps drop out the back and
 * the new request is admitted iff bucket size < limit.
 *
 * Sticky enough for the threat model (one triager session pinned to one BE
 * pod) and trivially swappable for Redis later.
 */

const WINDOW_MS = 3_600_000;

interface Bucket {
  timestamps: number[];
}

export interface CheckResult {
  allowed: boolean;
  /** Seconds until the next slot frees up. 0 when allowed. */
  retryAfterSec: number;
}

export interface WidgetRateLimiterDeps {
  now?: () => number;
}

export class WidgetRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(deps: WidgetRateLimiterDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  check(widgetProjectId: string, widgetUserId: string, limitPerHour: number): CheckResult {
    const key = `${widgetProjectId}::${widgetUserId}`;
    const t = this.now();
    const cutoff = t - WINDOW_MS;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] <= cutoff) {
      bucket.timestamps.shift();
    }
    if (bucket.timestamps.length < limitPerHour) {
      bucket.timestamps.push(t);
      return { allowed: true, retryAfterSec: 0 };
    }
    const oldest = bucket.timestamps[0];
    const retryAfterMs = oldest + WINDOW_MS - t;
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
}

/** Singleton shared across BE routes. */
export const widgetRateLimiter = new WidgetRateLimiter();
