import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the db module before any imports that use it
vi.mock('../db/index', () => ({
  db: {
    query: {
      userNotificationPreferences: { findFirst: vi.fn() },
      notificationMutes: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
  },
}))

import { applyGates } from './gates'
import { db } from '../db/index'

const mockDb = db as any
const mockPrefsFind: ReturnType<typeof vi.fn> = mockDb.query.userNotificationPreferences.findFirst
const mockMutesFind: ReturnType<typeof vi.fn> = mockDb.query.notificationMutes.findFirst

const ALL_ENABLED_PREFS = {
  userId: 'u1',
  inAppEnabled: true,
  browserEnabled: true,
  pushEnabled: true,
  emailEnabled: true,
}

function noMute() {
  mockMutesFind.mockResolvedValue(undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrefsFind.mockResolvedValue(ALL_ENABLED_PREFS)
  noMute()
})

// ─── Channel-disabled gates ───────────────────────────────────────────────────

it('blocks in_app when inAppEnabled=false', async () => {
  mockPrefsFind.mockResolvedValue({ ...ALL_ENABLED_PREFS, inAppEnabled: false })
  const result = await applyGates('u1', 'in_app', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'channel_disabled' })
})

it('blocks browser_api when browserEnabled=false', async () => {
  mockPrefsFind.mockResolvedValue({ ...ALL_ENABLED_PREFS, browserEnabled: false })
  const result = await applyGates('u1', 'browser_api', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'channel_disabled' })
})

it('blocks web_push when pushEnabled=false', async () => {
  mockPrefsFind.mockResolvedValue({ ...ALL_ENABLED_PREFS, pushEnabled: false })
  const result = await applyGates('u1', 'web_push', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'channel_disabled' })
})

it('blocks email when emailEnabled=false', async () => {
  mockPrefsFind.mockResolvedValue({ ...ALL_ENABLED_PREFS, emailEnabled: false })
  const result = await applyGates('u1', 'email', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'channel_disabled' })
})

// ─── Server-muted gates ───────────────────────────────────────────────────────

it('blocks in_app when server is permanently muted', async () => {
  mockMutesFind
    .mockResolvedValueOnce({ expiresAt: null }) // server mute
  const result = await applyGates('u1', 'in_app', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'server_muted' })
})

it('blocks browser_api when server is muted with future expiry', async () => {
  const future = new Date(Date.now() + 60_000)
  mockMutesFind
    .mockResolvedValueOnce({ expiresAt: future }) // server mute
  const result = await applyGates('u1', 'browser_api', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'server_muted' })
})

it('blocks web_push when server is muted', async () => {
  mockMutesFind.mockResolvedValueOnce({ expiresAt: null })
  const result = await applyGates('u1', 'web_push', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'server_muted' })
})

it('blocks email when server is muted', async () => {
  mockMutesFind.mockResolvedValueOnce({ expiresAt: null })
  const result = await applyGates('u1', 'email', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'server_muted' })
})

// ─── Project-muted gates ──────────────────────────────────────────────────────

it('blocks in_app when project is permanently muted', async () => {
  mockMutesFind
    .mockResolvedValueOnce(undefined)       // no server mute
    .mockResolvedValueOnce({ expiresAt: null }) // project mute
  const result = await applyGates('u1', 'in_app', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'project_muted' })
})

it('blocks email when project is muted', async () => {
  mockMutesFind
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ expiresAt: null })
  const result = await applyGates('u1', 'email', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: true, reason: 'project_muted' })
})

// ─── Happy path ───────────────────────────────────────────────────────────────

it('passes when all gates are clear', async () => {
  const result = await applyGates('u1', 'in_app', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: false })
})

// ─── Expired mute is ignored ──────────────────────────────────────────────────

it('does not block when server mute has already expired', async () => {
  const past = new Date(Date.now() - 1000)
  mockMutesFind
    .mockResolvedValueOnce({ expiresAt: past }) // expired server mute
    .mockResolvedValueOnce(undefined)            // no project mute
  const result = await applyGates('u1', 'in_app', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: false })
})

it('does not block when project mute has already expired', async () => {
  const past = new Date(Date.now() - 1000)
  mockMutesFind
    .mockResolvedValueOnce(undefined)      // no server mute
    .mockResolvedValueOnce({ expiresAt: past }) // expired project mute
  const result = await applyGates('u1', 'email', 'srv1', 'proj1')
  expect(result).toEqual({ blocked: false })
})
