import webpush from 'web-push'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index'
import { pushSubscriptions } from '../../db/schema'
import { markSent, markFailedOrRetry } from '../dispatch'
import type { NotificationDelivery, NotificationRow } from '../../db/schema'

if (process.env.WEB_PUSH_VAPID_PUBLIC_KEY && process.env.WEB_PUSH_VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.WEB_PUSH_VAPID_SUBJECT ?? 'mailto:notifications@runhq.io',
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
  )
}

const backoff = (n: number) => Math.min(30_000 * Math.pow(2, n - 1), 30 * 60_000)

export async function deliverWebPush(delivery: NotificationDelivery, notification: NotificationRow): Promise<void> {
  // If VAPID keys are not configured, treat as a no-op success.
  if (!process.env.WEB_PUSH_VAPID_PRIVATE_KEY) {
    await markSent(delivery.id)
    return
  }

  const subs = await db.query.pushSubscriptions.findMany({
    where: and(
      eq(pushSubscriptions.userId, notification.userId),
      eq(pushSubscriptions.platform, 'web_push'),
    ),
  })

  if (subs.length === 0) {
    await markSent(delivery.id)
    return
  }

  const payload = JSON.stringify({
    title: notification.eventType === 'need_help'
      ? `Needs help: ${notification.taskTitle}`
      : `Completed: ${notification.taskTitle}`,
    body:  `${notification.serverName} · ${notification.projectName}`,
    data:  {
      notificationId: notification.id,
      serverId:       notification.serverId,
      projectId:      notification.projectId,
      taskId:         notification.taskId,
    },
  })

  let anySuccess = false
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys as any },
        payload,
        { TTL: 60 },
      )
      anySuccess = true
      await db
        .update(pushSubscriptions)
        .set({ lastUsedAt: new Date() })
        .where(eq(pushSubscriptions.id, sub.id))
    } catch (err: any) {
      // 404/410 means the subscription is gone — remove it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id))
      } else {
        console.warn('[webPush] sendNotification error', err?.message)
      }
    }
  }

  if (anySuccess) {
    await markSent(delivery.id)
  } else {
    await markFailedOrRetry(delivery.id, 'all_subscriptions_failed', 8, backoff)
  }
}
