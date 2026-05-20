/**
 * End-to-end test: directly invoke WorkspaceTaskService.updateWorkspaceTask
 * with status='done' as an AGENT actor (so self-suppression doesn't fire),
 * then read back what landed in notifications + notification_deliveries.
 */
import 'dotenv/config'
import { updateTask } from '../src/api/services/WorkspaceTaskService'
import { db } from '../src/db/index'
import { eq } from 'drizzle-orm'
import { notifications, notificationDeliveries } from '../src/db/schema'

const TASK_ID = '00000000-0000-0000-0000-e2e000000ff1'
const RECIPIENT = '00000000-0000-0000-0000-e2e0000000a1'

async function main() {
  // Get the server_id from the seeded task
  const before = await db.execute(`SELECT server_id FROM workspace_tasks WHERE id = '${TASK_ID}'` as any)
  const serverId = (before as any).rows[0].server_id
  console.log('Server id:', serverId)

  // Trigger the transition: in_progress → done as agent actor
  const result = await updateTask(
    serverId,
    TASK_ID,
    { status: 'done' as any },
    { type: 'agent' },
  )
  console.log('Update result:', result?.status, result?.id)

  // Read what landed
  const notifs = await db.query.notifications.findMany({ where: eq(notifications.userId, RECIPIENT) })
  console.log(`\n✓ Notifications for recipient (${notifs.length} found):`)
  for (const n of notifs) {
    console.log(`  - ${n.eventType.toUpperCase()} · ${n.serverName} / ${n.projectName} / ${n.taskTitle}`)
    console.log(`    event_id: ${n.eventId}`)
    console.log(`    created:  ${n.createdAt?.toISOString()}`)

    const deliveries = await db.query.notificationDeliveries.findMany({
      where: eq(notificationDeliveries.notificationId, n.id),
    })
    console.log(`    deliveries (${deliveries.length}):`)
    for (const d of deliveries) {
      console.log(`      - ${d.channel}: ${d.status}${d.lastError ? ` (${d.lastError})` : ''}`)
    }
  }

  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
