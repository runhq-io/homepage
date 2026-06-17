/**
 * WidgetTicketEvents.test.ts — in-process pub/sub registry that feeds the
 * ticket-status SSE route. No DB, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { subscribeToTicket, publishTicketUpdate, ticketSubscriberCount } from './WidgetTicketEvents';

describe('WidgetTicketEvents', () => {
  it('delivers a publish to a subscriber of the same task', () => {
    const cb = vi.fn();
    const unsub = subscribeToTicket('task-1', cb);
    publishTicketUpdate('task-1');
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('isolates tasks — a publish only reaches subscribers of that task', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeToTicket('task-a', a);
    const unsubB = subscribeToTicket('task-b', b);
    publishTicketUpdate('task-a');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    unsubA();
    unsubB();
  });

  it('fans out to multiple subscribers of one task', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeToTicket('task-multi', a);
    const unsubB = subscribeToTicket('task-multi', b);
    publishTicketUpdate('task-multi');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it('unsubscribe stops further delivery and cleans up the task entry', () => {
    const cb = vi.fn();
    const unsub = subscribeToTicket('task-clean', cb);
    expect(ticketSubscriberCount('task-clean')).toBe(1);
    unsub();
    expect(ticketSubscriberCount('task-clean')).toBe(0);
    publishTicketUpdate('task-clean');
    expect(cb).not.toHaveBeenCalled();
  });

  it('publish to a task with no subscribers is a no-op (never throws)', () => {
    expect(() => publishTicketUpdate('nobody-home')).not.toThrow();
  });

  it('a throwing subscriber does not prevent delivery to others or throw', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const unsubBad = subscribeToTicket('task-throw', bad);
    const unsubGood = subscribeToTicket('task-throw', good);
    expect(() => publishTicketUpdate('task-throw')).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    unsubBad();
    unsubGood();
  });
});
