/**
 * CommunityNotificationService
 *
 * Handles listing, marking-read, and counting unread widget-user notifications.
 *
 * All queries use Drizzle ORM directly against the widgetUserNotifications table.
 * Cursor-based pagination is implemented via a createdAt timestamp cursor (ISO string).
 */

import { eq, and, lt, isNull, desc, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import {
  widgetUserNotifications,
  type WidgetUserNotification,
} from '../../db/schema';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface NotificationServiceDeps {
  /** Drizzle db instance. */
  db: NodePgDatabase<typeof schema>;
}

// ---------------------------------------------------------------------------
// CommunityNotificationService
// ---------------------------------------------------------------------------

export class CommunityNotificationService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(private deps: NotificationServiceDeps) {
    this.db = deps.db;
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /**
   * Returns paginated notifications for a widget user, newest first.
   *
   * @param args.widgetUserId - The calling widget user's id.
   * @param args.limit        - Max rows to return (capped at 100).
   * @param args.cursor       - Optional ISO timestamp cursor; returns rows
   *                            strictly older than the cursor value.
   */
  async list(args: {
    widgetUserId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ notifications: WidgetUserNotification[]; nextCursor: string | null }> {
    const effectiveLimit = Math.min(args.limit, 100);
    const fetchCount = effectiveLimit + 1;

    const conditions = args.cursor
      ? and(
          eq(widgetUserNotifications.widgetUserId, args.widgetUserId),
          lt(widgetUserNotifications.createdAt, new Date(args.cursor)),
        )
      : eq(widgetUserNotifications.widgetUserId, args.widgetUserId);

    const rows = await this.db
      .select()
      .from(widgetUserNotifications)
      .where(conditions)
      .orderBy(desc(widgetUserNotifications.createdAt))
      .limit(fetchCount);

    if (rows.length > effectiveLimit) {
      // There is at least one more page — set cursor to the last-returned row's createdAt.
      const page = rows.slice(0, effectiveLimit);
      const nextCursor = page[page.length - 1]!.createdAt.toISOString();
      return { notifications: page, nextCursor };
    }

    return { notifications: rows, nextCursor: null };
  }

  // -------------------------------------------------------------------------
  // markRead
  // -------------------------------------------------------------------------

  /**
   * Marks a single notification as read.
   *
   * Throws:
   *   - Error('Notification not found') — if no row with the given id exists.
   *   - Error('Forbidden')              — if the row belongs to a different widget user.
   *
   * If the notification is already read, returns { ok: true } as a no-op.
   */
  async markRead(args: {
    widgetUserId: string;
    notificationId: string;
  }): Promise<{ ok: true }> {
    // Fetch the notification to validate existence and ownership.
    const [row] = await this.db
      .select({
        id: widgetUserNotifications.id,
        widgetUserId: widgetUserNotifications.widgetUserId,
        readAt: widgetUserNotifications.readAt,
      })
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.id, args.notificationId))
      .limit(1);

    if (!row) {
      throw new Error('Notification not found');
    }
    if (row.widgetUserId !== args.widgetUserId) {
      throw new Error('Forbidden');
    }
    // Already read — no-op.
    if (row.readAt !== null) {
      return { ok: true };
    }

    await this.db
      .update(widgetUserNotifications)
      .set({ readAt: new Date() })
      .where(eq(widgetUserNotifications.id, args.notificationId));

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // markAllRead
  // -------------------------------------------------------------------------

  /**
   * Marks all unread notifications for the caller as read.
   *
   * Returns { ok: true, markedCount } where markedCount is the number of rows
   * that were freshly marked (already-read rows are not touched and don't count).
   */
  async markAllRead(args: {
    widgetUserId: string;
  }): Promise<{ ok: true; markedCount: number }> {
    const updated = await this.db
      .update(widgetUserNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(widgetUserNotifications.widgetUserId, args.widgetUserId),
          isNull(widgetUserNotifications.readAt),
        ),
      )
      .returning({ id: widgetUserNotifications.id });

    return { ok: true, markedCount: updated.length };
  }

  // -------------------------------------------------------------------------
  // unreadCount
  // -------------------------------------------------------------------------

  /**
   * Returns the count of unread notifications for the given widget user.
   */
  async unreadCount(widgetUserId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(widgetUserNotifications)
      .where(
        and(
          eq(widgetUserNotifications.widgetUserId, widgetUserId),
          isNull(widgetUserNotifications.readAt),
        ),
      );

    return result?.count ?? 0;
  }
}
