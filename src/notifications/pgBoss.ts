import { PgBoss } from 'pg-boss'
import { db } from '../db/index'
import { and, isNotNull, lte } from 'drizzle-orm'
import { notificationMutes } from '../db/schema'

type Boss = InstanceType<typeof PgBoss>

let instance: Boss | null = null

export async function startPgBoss(): Promise<Boss> {
  if (instance) return instance
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: 'pgboss' })
  boss.on('error', (err: unknown) => console.error('[pg-boss]', err))
  await boss.start()

  // Register the delivery worker — dynamically import dispatch to avoid
  // circular-reference issues at module load time. pg-boss v12 batches jobs;
  // we process them one at a time inside the callback.
  await boss.work<{ deliveryId: string }>('notification.deliver', async (jobs: any) => {
    const list = Array.isArray(jobs) ? jobs : [jobs]
    const { processDelivery } = await import('./dispatch')
    for (const job of list) {
      await processDelivery(job.data.deliveryId)
    }
  })

  // Nightly mute-sweep (expired mutes deleted at 04:00 UTC).
  try {
    await boss.schedule('mute-sweep', '0 4 * * *')
  } catch {
    // pg-boss throws if the schedule already exists with the same cron — safe to ignore.
  }
  await boss.work('mute-sweep', async () => {
    await db.delete(notificationMutes).where(
      and(
        isNotNull(notificationMutes.expiresAt),
        lte(notificationMutes.expiresAt, new Date()),
      ),
    )
    console.log('[notifications] mute-sweep complete')
  })

  instance = boss
  console.log('[notifications] pg-boss started')
  return boss
}

export function pgBoss(): Boss {
  if (!instance) throw new Error('pg-boss not started')
  return instance
}

export async function stopPgBoss() {
  if (instance) {
    await instance.stop()
    instance = null
  }
}
