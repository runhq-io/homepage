import type { NotificationRow } from '../db/schema'

export function serializeNotification(n: NotificationRow) {
  return {
    id:           n.id,
    server_id:    n.serverId,
    server_name:  n.serverName,
    project_id:   n.projectId,
    project_name: n.projectName,
    task_id:      n.taskId,
    task_title:   n.taskTitle,
    event_type:   n.eventType,
    read_at:      n.readAt ? n.readAt.toISOString() : null,
    archived_at:  n.archivedAt ? n.archivedAt.toISOString() : null,
    created_at:   n.createdAt.toISOString(),
  }
}
