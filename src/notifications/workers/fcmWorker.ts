import { markSkipped } from '../dispatch'
import type { NotificationDelivery, NotificationRow } from '../../db/schema'

/** FCM delivery is not yet implemented. Subscriptions are stored but the send path is a stub. */
export async function deliverFcm(delivery: NotificationDelivery, _notification: NotificationRow): Promise<void> {
  await markSkipped(delivery.id, 'platform_not_implemented')
}
