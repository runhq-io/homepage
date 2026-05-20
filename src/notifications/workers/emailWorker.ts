import { eq } from 'drizzle-orm'
import { db } from '../../db/index'
import { users } from '../../db/schema'
import { markSent, markSkipped, markFailedOrRetry } from '../dispatch'
import { sendJobStatusEmail } from '../email'
import type { NotificationDelivery, NotificationRow } from '../../db/schema'

const backoff = (n: number) => Math.min(60_000 * Math.pow(2, n - 1), 30 * 60_000)

export async function deliverEmail(delivery: NotificationDelivery, notification: NotificationRow): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, notification.userId) })
  if (!user?.email) {
    await markSkipped(delivery.id, 'no_email_address')
    return
  }

  try {
    await sendJobStatusEmail(
      { email: user.email, name: user.name },
      {
        id:          notification.id,
        eventType:   notification.eventType,
        taskTitle:   notification.taskTitle,
        serverName:  notification.serverName,
        projectName: notification.projectName,
        serverId:    notification.serverId,
        projectId:   notification.projectId,
        taskId:      notification.taskId,
      },
    )
    await markSent(delivery.id)
  } catch (err: any) {
    await markFailedOrRetry(delivery.id, String(err?.message ?? err), 6, backoff)
  }
}
