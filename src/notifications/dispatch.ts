import { db } from '../db/index'
import { eq, sql } from 'drizzle-orm'
import { notifications, notificationDeliveries } from '../db/schema'
import { applyGates } from './gates'
import { deliverInApp } from './workers/inAppWorker'
import { deliverBrowserApi } from './workers/browserApiWorker'
import { deliverWebPush } from './workers/webPushWorker'
import { deliverEmail } from './workers/emailWorker'
import { deliverApns } from './workers/apnsWorker'
import { deliverFcm } from './workers/fcmWorker'

/**
 * Attempt to process a single delivery row.
 *
 * Idempotent: if the row is not in 'pending' status (because a concurrent
 * worker already claimed it), this is a no-op.
 */
export async function processDelivery(deliveryId: string): Promise<void> {
  // Attempt to lock the row. We do a conditional UPDATE that only touches
  // rows still in 'pending' status and returns the updated id.
  // If another worker already claimed it the UPDATE will match 0 rows → skip.
  const claimed = await db.execute(sql`
    UPDATE notification_deliveries
       SET status = 'pending'          -- idempotent: same value, just for the row-lock
     WHERE id = ${deliveryId} AND status = 'pending'
    RETURNING id
  `)
  const claimedRow = (claimed as any).rows?.[0] ?? (Array.isArray(claimed) ? claimed[0] : null)
  if (!claimedRow) return

  const delivery = await db.query.notificationDeliveries.findFirst({
    where: eq(notificationDeliveries.id, deliveryId),
  })
  if (!delivery || delivery.status !== 'pending') return

  const notification = await db.query.notifications.findFirst({
    where: eq(notifications.id, delivery.notificationId),
  })
  if (!notification) return

  const gate = await applyGates(
    notification.userId,
    delivery.channel as any,
    notification.serverId,
    notification.projectId,
  )
  if (gate.blocked) {
    await markSkipped(deliveryId, gate.reason!)
    return
  }

  try {
    switch (delivery.channel) {
      case 'in_app':      await deliverInApp(delivery, notification);      break
      case 'browser_api': await deliverBrowserApi(delivery, notification);  break
      case 'web_push':    await deliverWebPush(delivery, notification);     break
      case 'apns':        await deliverApns(delivery, notification);        break
      case 'fcm':         await deliverFcm(delivery, notification);         break
      case 'email':       await deliverEmail(delivery, notification);       break
    }
  } catch (err: any) {
    // Workers should handle their own retries; if they throw anyway, apply a
    // small retry budget with exponential backoff (cap at 5 min).
    await markFailedOrRetry(
      deliveryId,
      String(err?.message ?? err),
      5,
      (n) => Math.min(30_000 * n, 5 * 60_000),
    )
  }
}

export async function markSent(deliveryId: string) {
  await db
    .update(notificationDeliveries)
    .set({ status: 'sent', deliveredAt: new Date() })
    .where(eq(notificationDeliveries.id, deliveryId))
}

export async function markSkipped(deliveryId: string, reason: string) {
  await db
    .update(notificationDeliveries)
    .set({ status: 'skipped', lastError: reason })
    .where(eq(notificationDeliveries.id, deliveryId))
}

export async function markFailedOrRetry(
  deliveryId: string,
  error: string,
  retryBudget: number,
  backoffMs: (n: number) => number,
) {
  const d = await db.query.notificationDeliveries.findFirst({
    where: eq(notificationDeliveries.id, deliveryId),
  })
  if (!d) return
  const attempts = d.attempts + 1
  if (attempts >= retryBudget) {
    await db
      .update(notificationDeliveries)
      .set({ status: 'dead', attempts, lastError: error })
      .where(eq(notificationDeliveries.id, deliveryId))
  } else {
    await db
      .update(notificationDeliveries)
      .set({
        attempts,
        lastError: error,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      })
      .where(eq(notificationDeliveries.id, deliveryId))
  }
}

/**
 * Dispatch all pending delivery rows for a notification.
 *
 * In-app and browser_api deliveries are sent synchronously (they go via WS
 * and are cheap). All other channels are enqueued via pg-boss so they survive
 * process restarts. Falls back gracefully if pg-boss is not started (the
 * periodic poller will pick them up).
 */
export async function dispatchNotification(notificationId: string): Promise<void> {
  const deliveries = await db.query.notificationDeliveries.findMany({
    where: eq(notificationDeliveries.notificationId, notificationId),
  })

  for (const d of deliveries) {
    if (d.channel === 'in_app' || d.channel === 'browser_api') {
      // Direct call — lightweight WS push, no queue needed.
      void processDelivery(d.id).catch((err) =>
        console.warn('[notifications] inline delivery failed', err),
      )
    } else {
      try {
        // Lazy-import to avoid startup circular-dep between this module and pgBoss.
        const { pgBoss } = await import('./pgBoss')
        await pgBoss().send('notification.deliver', { deliveryId: d.id }, { singletonKey: d.id })
      } catch (err) {
        // pg-boss not started or send failed — poller will pick it up.
        console.warn('[notifications] pg-boss enqueue failed (poller will retry)', err)
      }
    }
  }
}
