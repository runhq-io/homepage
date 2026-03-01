import { NextResponse } from 'next/server';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  max: number; // Max requests per window
}

/**
 * Simple in-memory rate limiter.
 * Good enough for single-process deployments (Fly.io single machine per app).
 * For multi-instance, use Redis-based rate limiting.
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max } = options;
  const store = new Map<string, RateLimitEntry>();

  // Cleanup expired entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  }, 5 * 60 * 1000).unref();

  return {
    /**
     * Check if the key is within the rate limit.
     * Returns true if allowed, false if rate limited.
     */
    check(key: string): boolean {
      const now = Date.now();
      const entry = store.get(key);

      if (!entry || entry.resetAt <= now) {
        // New window
        store.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      entry.count++;
      if (entry.count > max) {
        return false;
      }

      return true;
    },
  };
}

/**
 * Standard 429 response for rate-limited requests.
 */
export function rateLimitResponse(headers?: Record<string, string>): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    { status: 429, headers: { ...headers, 'Retry-After': '60' } }
  );
}
