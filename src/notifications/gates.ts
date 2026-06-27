import { db } from '../db/index'
import { eq, and } from 'drizzle-orm'
import { userNotificationPreferences, notificationMutes } from '../db/schema'

type Channel = 'in_app' | 'browser_api' | 'web_push' | 'apns' | 'fcm' | 'email'

const channelToPref: Record<Channel, keyof typeof userNotificationPreferences.$inferSelect> = {
  in_app:      'inAppEnabled',
  browser_api: 'browserEnabled',
  web_push:    'pushEnabled',
  apns:        'pushEnabled',
  fcm:         'pushEnabled',
  email:       'emailEnabled',
}

export async function getOrCreatePreferences(userId: string) {
  const existing = await db.query.userNotificationPreferences.findFirst({
    where: eq(userNotificationPreferences.userId, userId),
  })
  if (existing) return existing
  await db.insert(userNotificationPreferences).values({ userId }).onConflictDoNothing()
  return (await db.query.userNotificationPreferences.findFirst({
    where: eq(userNotificationPreferences.userId, userId),
  }))!
}

function isMuteActive(m: { expiresAt: Date | null } | undefined): boolean {
  if (!m) return false
  return m.expiresAt === null || m.expiresAt > new Date()
}

export async function applyGates(
  userId: string,
  channel: Channel,
  serverId: string,
  projectId: string,
): Promise<{ blocked: boolean; reason?: string }> {
  const prefs = await getOrCreatePreferences(userId)

  // Gate 1: channel enabled in user preferences
  if (!(prefs as any)[channelToPref[channel]]) {
    return { blocked: true, reason: 'channel_disabled' }
  }

  // Gate 2: server-level mute
  const serverMute = await db.query.notificationMutes.findFirst({
    where: and(
      eq(notificationMutes.userId, userId),
      eq(notificationMutes.scopeType, 'server'),
      eq(notificationMutes.scopeId, serverId),
    ),
  })
  if (isMuteActive(serverMute)) return { blocked: true, reason: 'server_muted' }

  // Gate 3: project-level mute
  const projectMute = await db.query.notificationMutes.findFirst({
    where: and(
      eq(notificationMutes.userId, userId),
      eq(notificationMutes.scopeType, 'project'),
      eq(notificationMutes.scopeId, projectId),
    ),
  })
  if (isMuteActive(projectMute)) return { blocked: true, reason: 'project_muted' }

  return { blocked: false }
}
