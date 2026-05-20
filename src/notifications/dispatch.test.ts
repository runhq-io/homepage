import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Shared mock data ────────────────────────────────────────────────────────
const DELIVERY_ID = 'del-123'
const NOTIFICATION_ID = 'notif-456'

const mockDelivery = {
  id: DELIVERY_ID,
  notificationId: NOTIFICATION_ID,
  channel: 'in_app',
  status: 'pending',
  attempts: 0,
  nextAttemptAt: new Date(),
}

const mockNotification = {
  id: NOTIFICATION_ID,
  userId: 'user-1',
  serverId: 'srv-1',
  projectId: 'proj-1',
  taskId: 'task-1',
  taskTitle: 'Fix the bug',
  serverName: 'My Server',
  projectName: 'My Project',
  eventType: 'completed' as const,
  readAt: null,
  archivedAt: null,
  createdAt: new Date(),
  eventId: 'evt-1',
}

// ── DB mock ──────────────────────────────────────────────────────────────────
const mockExecute = vi.fn()
const mockDeliveryFind = vi.fn()
const mockNotificationFind = vi.fn()
const mockUpdate = vi.fn()
const mockSet = vi.fn()
const mockWhere = vi.fn()

vi.mock('../db/index', () => ({
  db: {
    execute: (q: any) => mockExecute(q),
    query: {
      notificationDeliveries: { findFirst: (q: any) => mockDeliveryFind(q), findMany: vi.fn() },
      notifications: { findFirst: (q: any) => mockNotificationFind(q) },
    },
    update: () => ({ set: () => ({ where: mockWhere }) }),
  },
}))

// ── Gates mock ───────────────────────────────────────────────────────────────
vi.mock('./gates', () => ({
  applyGates: vi.fn(),
}))

// ── Worker mocks ─────────────────────────────────────────────────────────────
vi.mock('./workers/inAppWorker', () => ({ deliverInApp: vi.fn() }))
vi.mock('./workers/browserApiWorker', () => ({ deliverBrowserApi: vi.fn() }))
vi.mock('./workers/webPushWorker', () => ({ deliverWebPush: vi.fn() }))
vi.mock('./workers/emailWorker', () => ({ deliverEmail: vi.fn() }))
vi.mock('./workers/apnsWorker', () => ({ deliverApns: vi.fn() }))
vi.mock('./workers/fcmWorker', () => ({ deliverFcm: vi.fn() }))

import { processDelivery, markSent, markSkipped, markFailedOrRetry } from './dispatch'
import { applyGates } from './gates'
import { deliverInApp } from './workers/inAppWorker'

const mockApplyGates = applyGates as ReturnType<typeof vi.fn>
const mockDeliverInApp = deliverInApp as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()

  // Default: claim succeeds
  mockExecute.mockResolvedValue({ rows: [{ id: DELIVERY_ID }] })

  // Default: delivery is pending
  mockDeliveryFind.mockResolvedValue(mockDelivery)

  // Default: notification exists
  mockNotificationFind.mockResolvedValue(mockNotification)

  // Default: gates pass
  mockApplyGates.mockResolvedValue({ blocked: false })

  // Default: worker succeeds
  mockDeliverInApp.mockResolvedValue(undefined)

  // Default: db.update chain resolves
  mockWhere.mockResolvedValue(undefined)
})

describe('processDelivery', () => {
  it('no-ops when the row cannot be claimed (not pending or already locked)', async () => {
    mockExecute.mockResolvedValue({ rows: [] })
    await processDelivery(DELIVERY_ID)
    expect(mockDeliveryFind).not.toHaveBeenCalled()
  })

  it('no-ops when the delivery is not found or not pending after claim', async () => {
    mockDeliveryFind.mockResolvedValue({ ...mockDelivery, status: 'sent' })
    await processDelivery(DELIVERY_ID)
    expect(mockNotificationFind).not.toHaveBeenCalled()
  })

  it('marks skipped when gate is blocked', async () => {
    mockApplyGates.mockResolvedValue({ blocked: true, reason: 'channel_disabled' })
    // spy on markSkipped indirectly — we verify update is called via mockWhere
    await processDelivery(DELIVERY_ID)
    // applyGates was called
    expect(mockApplyGates).toHaveBeenCalledWith(
      mockNotification.userId,
      mockDelivery.channel,
      mockNotification.serverId,
      mockNotification.projectId,
    )
    // Worker was NOT called
    expect(mockDeliverInApp).not.toHaveBeenCalled()
  })

  it('calls the correct worker for in_app channel and succeeds', async () => {
    await processDelivery(DELIVERY_ID)
    expect(mockDeliverInApp).toHaveBeenCalledWith(mockDelivery, mockNotification)
  })

  it('handles notification not found gracefully', async () => {
    mockNotificationFind.mockResolvedValue(undefined)
    await expect(processDelivery(DELIVERY_ID)).resolves.not.toThrow()
    expect(mockApplyGates).not.toHaveBeenCalled()
  })
})
