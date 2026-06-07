/**
 * chat_message rate-limit class: 60/user/hour per the widget-chat contract,
 * with its own sliding-window bucket so chatting doesn't consume the
 * ticket-creation budget (and vice versa).
 */
import { describe, it, expect } from 'vitest';
import { WidgetRateLimiter, WIDGET_ACTION_LIMITS } from './WidgetRateLimiter';

describe('chat_message action', () => {
  it('pins the contract limit: 60 per hour', () => {
    expect(WIDGET_ACTION_LIMITS.chat_message).toBe(60);
  });

  it('admits 60, blocks the 61st with a retry hint, then slides', () => {
    let now = 1_000_000;
    const limiter = new WidgetRateLimiter({ now: () => now });
    for (let i = 0; i < 60; i++) {
      expect(limiter.checkDefault('proj', 'user', 'chat_message').allowed).toBe(true);
    }
    const blocked = limiter.checkDefault('proj', 'user', 'chat_message');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    now += 3_600_001; // the whole window expires
    expect(limiter.checkDefault('proj', 'user', 'chat_message').allowed).toBe(true);
  });

  it('keeps its own bucket — chat does not consume the ticket_create budget', () => {
    const limiter = new WidgetRateLimiter({ now: () => 1 });
    for (let i = 0; i < 60; i++) limiter.checkDefault('proj', 'user', 'chat_message');
    expect(limiter.checkDefault('proj', 'user', 'chat_message').allowed).toBe(false);
    expect(limiter.checkDefault('proj', 'user', 'ticket_create').allowed).toBe(true);
  });
});
