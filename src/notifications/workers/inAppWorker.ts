import { wsServer } from '../wsRegistry'
import { broadcastToUser } from '../wsBroadcast'
import { serializeNotification } from '../serialize'
import { markSent } from '../dispatch'
import type { NotificationDelivery, NotificationRow } from '../../db/schema'

export async function deliverInApp(delivery: NotificationDelivery, notification: NotificationRow): Promise<void> {
  try {
    broadcastToUser(wsServer(), notification.userId, {
      type: 'notification:new',
      notification: serializeNotification(notification),
    })
  } catch {
    // WS server not registered (tests, cold boot) — delivery is still
    // marked sent because the row serves as the persistent in-app record.
    // The client will fetch it on next load via GET /api/notifications.
  }
  await markSent(delivery.id)
}
