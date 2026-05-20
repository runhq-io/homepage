import { db } from '../../db/index'
import { sql } from 'drizzle-orm'
import { processDelivery } from '../dispatch'

const CHANNELS = ['in_app', 'browser_api', 'web_push', 'apns', 'fcm', 'email'] as const

/**
 * Periodic delivery poller.
 *
 * Polls all channels for deliveries whose next_attempt_at is due, and processes
 * them in order. When there is work to do it ticks at 500 ms; when idle it
 * backs off to 2 s.
 *
 * This acts as a reliable fallback for cases where pg-boss failed to enqueue
 * (transient errors at notification emit time) or where the pg-boss worker
 * process restarted before the job was consumed.
 */
export class DeliveryPoller {
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  start() {
    void this.tick()
  }

  async stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private async tick() {
    if (this.stopped) return
    let processed = 0
    try {
      for (const channel of CHANNELS) {
        const rows = await db.execute(sql`
          SELECT id FROM notification_deliveries
           WHERE channel = ${channel}
             AND status  = 'pending'
             AND next_attempt_at <= now()
           ORDER BY next_attempt_at ASC
           LIMIT 25
        `)
        const list = ((rows as any).rows ?? rows) as Array<{ id: string }>
        for (const r of list) {
          await processDelivery(r.id)
          processed++
        }
      }
    } catch (err) {
      console.error('[notifications] delivery poller error', err)
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), processed ? 500 : 2_000)
      }
    }
  }
}
