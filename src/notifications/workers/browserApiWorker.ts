import { wsServer } from '../wsRegistry'
import { broadcastToUser } from '../wsBroadcast'
import { serializeNotification } from '../serialize'
import { markSent } from '../dispatch'
import type { NotificationDelivery, NotificationRow } from '../../db/schema'

export async function deliverBrowserApi(delivery: NotificationDelivery, notification: NotificationRow): Promise<void> {
  try {
    broadcastToUser(wsServer(), notification.userId, {
      type: 'notification:browser-popup',
      notification: serializeNotification(notification),
    })
  } catch {
    // WS server not registered — silently skip the push; in-app row is persistent.
  }
  await markSent(delivery.id)
}
