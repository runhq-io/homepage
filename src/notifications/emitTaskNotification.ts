import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  servers,
  notifications,
  notificationDeliveries,
  pushSubscriptions,
} from '../db/schema'

export type NotificationActor =
  | { type: 'user'; userId: string }
  | { type: 'agent' }
  | { type: 'system' }

export type TaskRowForNotification = {
  id: string
  serverId: string
  workspaceProjectId: string | null
  workspaceChannelId: string | null
  /** Workspace job/session bound to this task, if any. */
  workspaceJobId: string | null
  title: string
  createdById: string | null
  lastInteractorUserId: string | null
}

export type NotificationContent = {
  userId: string
  serverId: string
  serverName: string
  projectId: string
  projectName: string
  taskId: string
  taskTitle: string
  /** Workspace channel for deep-linking; null when there is no target. */
  channelId: string | null
  /** Workspace job/session bound to the task; preferred deep-link target. */
  jobId: string | null
  eventType: 'completed' | 'need_help'
}

/**
 * Writes one `notifications` row + one `notification_deliveries` row per
 * applicable channel for an already-resolved recipient and content.
 *
 * Shared core used by both real task-transition notifications
 * (emitTaskNotification) and the user-triggered test notification
 * (POST /api/notifications/test) so both exercise the identical delivery
 * pipeline: in_app/browser_api/email always; web_push/apns/fcm only when the
 * recipient has a matching push subscription.
 *
 * Returns the new notification id, or null on a no-op (duplicate eventId).
 */
export async function insertNotificationWithDeliveries(
  tx: any,
  content: NotificationContent,
): Promise<string | null> {
  const subs = await tx.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, content.userId),
  })
  const hasWebPush = subs.some((s: typeof pushSubscriptions.$inferSelect) => s.platform === 'web_push')
  const hasAPNS    = subs.some((s: typeof pushSubscriptions.$inferSelect) => s.platform === 'apns')
  const hasFCM     = subs.some((s: typeof pushSubscriptions.$inferSelect) => s.platform === 'fcm')

  const inserted = await tx
    .insert(notifications)
    .values({
      userId: content.userId,
      eventId: randomUUID(),
      serverId: content.serverId,
      serverName: content.serverName,
      projectId: content.projectId,
      projectName: content.projectName,
      taskId: content.taskId,
      taskTitle: content.taskTitle,
      channelId: content.channelId,
      jobId: content.jobId,
      eventType: content.eventType,
    })
    .onConflictDoNothing({ target: notifications.eventId })
    .returning({ id: notifications.id })

  if (inserted.length === 0) return null
  const notificationId = inserted[0].id

  const channels: Array<'in_app' | 'browser_api' | 'web_push' | 'apns' | 'fcm' | 'email'> = [
    'in_app',
    'browser_api',
    'email',
  ]
  if (hasWebPush) channels.push('web_push')
  if (hasAPNS)    channels.push('apns')
  if (hasFCM)     channels.push('fcm')

  await tx.insert(notificationDeliveries).values(
    channels.map((channel) => ({
      notificationId,
      channel,
      status: 'pending' as const,
      nextAttemptAt: new Date(),
    })),
  )

  return notificationId
}

/**
 * Writes a `notifications` row + one `notification_deliveries` row per
 * applicable channel inside an existing DB transaction.
 *
 * Returns the new notification ID, or null if no notification was emitted.
 *
 * Rules:
 *  - Only fires for `needs_review` or `done` transitions (caller's responsibility
 *    to call only when `newStatus !== prev.status`).
 *  - Recipient = row.lastInteractorUserId ?? row.createdById. Skips if null.
 *  - Self-suppression: skips if actor is a user and actor.userId === recipient.
 *  - workspaceProjectId is required; skips if null.
 *
 * Note on project name: there is no separate workspaceProjects table in the BE
 * schema. The workspaceProjectId is a free-form text string originating from
 * the workspace SQLite. We store the projectId itself as the projectName
 * snapshot until a future phase adds a project-name sync mechanism.
 */
export async function emitTaskNotification(
  // PgTransaction — loosely typed because Drizzle's generic tx type is verbose
  // and varies between Neon/node-postgres drivers. The interface is identical.
  tx: any,
  row: TaskRowForNotification,
  _prev: TaskRowForNotification,
  newStatus: 'needs_review' | 'done',
  actor: NotificationActor,
): Promise<string | null> {
  // --- Recipient resolution ---
  const recipient = row.lastInteractorUserId ?? row.createdById
  if (!recipient) return null

  // Self-suppression: if the acting user IS the intended recipient, no ping.
  if (actor.type === 'user' && actor.userId === recipient) return null

  // Project is contextual, not required. Many tasks (todos created directly in
  // a channel) have no project — workspaceProjectId is then null OR an empty
  // string. Do NOT bail in that case: the notification (server + task + status)
  // is still meaningful. Fall back to an empty project id/name; the client
  // renders the project segment only when present.
  const projectId = row.workspaceProjectId || ''

  // --- Server name snapshot ---
  // servers.id is a text field (ws_<base36>_<random>); findFirst by text eq.
  const server = await tx.query.servers.findFirst({
    where: eq(servers.id, row.serverId),
  })
  if (!server) return null // server vanished or ID mismatch — defensive

  // --- Project name snapshot ---
  // No workspaceProjects table exists in the BE schema. The projectId is a
  // free-form string from the workspace SQLite. Store the id as the name until
  // a future phase provides a name-sync mechanism.
  const projectName = projectId

  return insertNotificationWithDeliveries(tx, {
    userId: recipient,
    serverId: row.serverId,
    serverName: server.name ?? row.serverId,
    projectId,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    channelId: row.workspaceChannelId,
    jobId: row.workspaceJobId,
    eventType: newStatus === 'done' ? 'completed' : 'need_help',
  })
}
