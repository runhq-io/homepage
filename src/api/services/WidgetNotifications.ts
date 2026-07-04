/**
 * WidgetNotifications.ts — in-process pub/sub keyed by widget USER, feeding the
 * per-user notifications SSE (GET /api/widget/notifications/events).
 *
 * Mirrors WidgetTicketEvents (per-ticket) and WidgetChatService (per-conversation),
 * but the channel is the viewer, so ONE background stream can drive the whole
 * launcher/bell unread badge in real time — instead of the client polling.
 *
 * A publish carries NO payload: it is a "something you care about changed,
 * re-fetch your counts" signal. The client responds by reloading its badge
 * caches. One BE pod per widget user (same stickiness assumption the rate
 * limiter and the other buses already make).
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { workspaceTasks, workspaceTaskActivity, widgetUsers, widgetProjects } from '../../db/schema';

type UserSubscriber = () => void;

const subscribers = new Map<string, Set<UserSubscriber>>();

export function subscribeToUser(widgetUserId: string, cb: UserSubscriber): () => void {
  let set = subscribers.get(widgetUserId);
  if (!set) {
    set = new Set();
    subscribers.set(widgetUserId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(widgetUserId);
  };
}

/**
 * Signal a single widget user's live subscribers. Best-effort and total: a
 * throwing subscriber is logged and skipped; an unknown user is a no-op. MUST
 * never throw — it is called from authoritative write paths.
 */
export function publishToUser(widgetUserId: string): void {
  const set = subscribers.get(widgetUserId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb();
    } catch (err) {
      console.warn('[WidgetNotifications] subscriber threw:', err);
    }
  }
}

/** True when at least one user anywhere has a live subscription. */
export function anyUserSubscribers(): boolean {
  return subscribers.size > 0;
}

/** Test/diagnostic helper: number of live subscribers for a user. */
export function userSubscriberCount(widgetUserId: string): number {
  return subscribers.get(widgetUserId)?.size ?? 0;
}

/**
 * Resolve who cares about a task and ping their notification channels: the
 * REPORTER (the external widget user who filed it) and the ASSIGNER (the widget
 * user whose externalUserId authored the latest `agent_assigned` activity). Both
 * drive the same unread badge. Best-effort and async; never throws. Skips all DB
 * work when nobody is currently subscribed anywhere.
 */
export async function notifyTaskAudience(taskId: string): Promise<void> {
  if (!anyUserSubscribers()) return;
  try {
    const [task] = await db
      .select({
        createdByType: workspaceTasks.createdByType,
        createdById: workspaceTasks.createdById,
        serverId: workspaceTasks.serverId,
      })
      .from(workspaceTasks)
      .where(eq(workspaceTasks.id, taskId))
      .limit(1);
    if (!task) return;

    const targets = new Set<string>();
    // Reporter: createdById IS a widget_users id when the filer is external.
    if (task.createdByType === 'external' && task.createdById) targets.add(task.createdById);

    // Assigner: the latest agent_assigned activity records the assigner's
    // externalUserId; resolve it to widget_users id(s) on the same server.
    const [assign] = await db
      .select({ createdById: workspaceTaskActivity.createdById })
      .from(workspaceTaskActivity)
      .where(and(
        eq(workspaceTaskActivity.taskId, taskId),
        eq(workspaceTaskActivity.type, 'agent_assigned'),
      ))
      .orderBy(desc(workspaceTaskActivity.createdAt))
      .limit(1);
    if (assign?.createdById) {
      const rows = await db
        .select({ id: widgetUsers.id })
        .from(widgetUsers)
        .innerJoin(widgetProjects, eq(widgetUsers.projectId, widgetProjects.id))
        .where(and(
          eq(widgetProjects.serverId, task.serverId),
          eq(widgetUsers.externalUserId, assign.createdById),
        ));
      for (const r of rows) targets.add(r.id);
    }

    for (const uid of targets) publishToUser(uid);
  } catch (err) {
    console.warn('[WidgetNotifications] notifyTaskAudience failed:', err);
  }
}
