/**
 * WidgetTicketEvents.ts — in-process pub/sub that feeds the ticket-status SSE
 * route (GET /api/widget/tickets/:id/events).
 *
 * Mirrors the WidgetChatService pub/sub. A publish carries NO payload: it is a
 * "task X changed, recompute" signal. Each SSE connection recomputes its own
 * viewer-specific PublicTicketDetail, because per-viewer visibility (private
 * tickets, clarifier open questions) means there is no single shared payload.
 *
 * One BE pod per widget user — the same stickiness assumption the
 * WidgetRateLimiter already makes.
 */

type TicketSubscriber = () => void;

const subscribers = new Map<string, Set<TicketSubscriber>>();

export function subscribeToTicket(taskId: string, cb: TicketSubscriber): () => void {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(taskId);
  };
}

/**
 * Signal every live subscriber that the given ticket changed. Best-effort and
 * total: a throwing subscriber is logged and skipped; an unknown task is a
 * no-op. This MUST never throw — it is called from authoritative write paths
 * that must not be rolled back by a notification failure.
 */
export function publishTicketUpdate(taskId: string): void {
  const set = subscribers.get(taskId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb();
    } catch (err) {
      console.warn('[WidgetTicketEvents] subscriber threw:', err);
    }
  }
}

/** Test/diagnostic helper: number of live subscribers for a task. */
export function ticketSubscriberCount(taskId: string): number {
  return subscribers.get(taskId)?.size ?? 0;
}
