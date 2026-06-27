import type { NotificationRow } from '../db/schema'

/** The wire shape returned by /api/notifications and pushed over WS. */
export interface SerializedNotification {
  id: string;
  /** Recipient user id. Used by the per-server WS push path to target the
   *  right socket; harmless on the client because /api/notifications already
   *  scopes by auth. */
  user_id: string;
  server_id: string;
  server_name: string;
  project_id: string;
  project_name: string;
  task_id: string;
  task_title: string;
  /** Workspace channel the task/job lives in. Used as a deep-link fallback
   *  when there is no running job/session. Null on test notifications. */
  channel_id: string | null;
  /** Workspace job/session the task is bound to. When present the client
   *  deep-links to /server/:server_id/session/:job_id (the actual job), not
   *  the todo's channel. Null when no session exists yet. */
  job_id: string | null;
  event_type: 'need_help' | 'completed';
  read_at: string | null;
  archived_at: string | null;
  created_at: string;
}

export function serializeNotification(n: NotificationRow): SerializedNotification {
  return {
    id:           n.id,
    user_id:      n.userId,
    server_id:    n.serverId,
    server_name:  n.serverName,
    project_id:   n.projectId,
    project_name: n.projectName,
    task_id:      n.taskId,
    task_title:   n.taskTitle,
    channel_id:   n.channelId ?? null,
    job_id:       n.jobId ?? null,
    event_type:   n.eventType,
    read_at:      n.readAt ? n.readAt.toISOString() : null,
    archived_at:  n.archivedAt ? n.archivedAt.toISOString() : null,
    created_at:   n.createdAt.toISOString(),
  }
}
