/**
 * In-memory sliding-window rate limiter for widget-side mutations.
 *
 * Buckets are keyed by (widgetProjectId, widgetUserId, action). Each bucket
 * stores recent timestamps; on `check`, expired timestamps drop out the back
 * and the new request is admitted iff bucket size < limit.
 *
 * Each `WidgetAction` has its own bucket so that comments don't eat into the
 * ticket-creation budget (and vice versa). Sticky enough for the threat model
 * (one widget user pinned to one BE pod) and trivially swappable for Redis
 * later — the public surface is `check(projectId, userId, action, limit)`.
 */

const WINDOW_MS = 3_600_000;

/**
 * Per-action limits and their human-readable purpose.
 *
 * The values are intentionally generous for legitimate use but tight enough
 * that an attacker holding a single widget JWT cannot meaningfully abuse the
 * surface (e.g. flood the workspace UI, inflate the title-generation LLM
 * bill, or push attachment storage costs). All limits are per-user-per-hour.
 */
export const WIDGET_ACTION_LIMITS = {
  ticket_create: 10,
  ticket_update: 30,
  ticket_delete: 10,
  vote: 60,
  comment_create: 30,
  comment_update: 30,
  comment_delete: 30,
  attachment_upload: 20,
  /** Widget chat user messages — each one dispatches a paid agent turn. */
  chat_message: 60,
  /** Triager assignment — overridden per-project via widgetAssignRateLimitPerHour. */
  triager_assign: 30,
} as const;

export type WidgetAction = keyof typeof WIDGET_ACTION_LIMITS;

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

  /**
   * Check whether a new request is allowed and atomically record it if so.
   *
   * @param widgetProjectId  Scopes the bucket to one widget project.
   * @param widgetUserId     The identified end-user the limit is enforced against.
   * @param action           Which action class (each gets its own bucket).
   * @param limitPerHour     Hourly cap. For `triager_assign` callers should
   *                         pass the per-project override; for other actions
   *                         the constant from `WIDGET_ACTION_LIMITS` is fine.
   */
  check(
    widgetProjectId: string,
    widgetUserId: string,
    action: WidgetAction,
    limitPerHour: number,
  ): CheckResult {
    const key = `${widgetProjectId}::${widgetUserId}::${action}`;
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

  /**
   * Convenience: check using the default limit baked into `WIDGET_ACTION_LIMITS`.
   * Use `check()` directly when the limit needs to come from config.
   */
  checkDefault(
    widgetProjectId: string,
    widgetUserId: string,
    action: WidgetAction,
  ): CheckResult {
    return this.check(widgetProjectId, widgetUserId, action, WIDGET_ACTION_LIMITS[action]);
  }
}

/** Singleton shared across BE routes. */
export const widgetRateLimiter = new WidgetRateLimiter();
