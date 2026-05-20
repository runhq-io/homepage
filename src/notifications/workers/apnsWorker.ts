import { markSkipped } from '../dispatch'
import type { NotificationDelivery, NotificationRow } from '../../db/schema'

/** APNS delivery is not yet implemented. Subscriptions are stored but the send path is a stub. */
export async function deliverApns(delivery: NotificationDelivery, _notification: NotificationRow): Promise<void> {
  await markSkipped(delivery.id, 'platform_not_implemented')
}
