import { describe, it, expect, vi } from 'vitest'
import { broadcastToUser } from './wsBroadcast'

function makeFakeWs(sockets: Array<{ send: ReturnType<typeof vi.fn>; readyState: number }>) {
  return {
    getSocketsForUser: (_userId: string) => sockets as any,
  } as any
}

describe('broadcastToUser', () => {
  it('sends serialised message to all sockets', () => {
    const send1 = vi.fn()
    const send2 = vi.fn()
    const ws = makeFakeWs([
      { send: send1, readyState: 1 },
      { send: send2, readyState: 1 },
    ])
    const msg = { type: 'notification:new', notification: { id: 'abc' } }
    const count = broadcastToUser(ws, 'user-1', msg)

    expect(count).toBe(2)
    expect(send1).toHaveBeenCalledWith(JSON.stringify(msg))
    expect(send2).toHaveBeenCalledWith(JSON.stringify(msg))
  })

  it('returns 0 when no sockets exist for user', () => {
    const ws = makeFakeWs([])
    const count = broadcastToUser(ws, 'user-nobody', { type: 'notification:new' })
    expect(count).toBe(0)
  })

  it('does not throw if a socket send throws', () => {
    const badSend = vi.fn().mockImplementation(() => { throw new Error('socket closed') })
    const ws = makeFakeWs([{ send: badSend, readyState: 1 }])
    expect(() => broadcastToUser(ws, 'user-1', { type: 'test' })).not.toThrow()
  })

  it('sends to multiple sockets for the same user', () => {
    const sends = [vi.fn(), vi.fn(), vi.fn()]
    const ws = makeFakeWs(sends.map(send => ({ send, readyState: 1 })))
    const count = broadcastToUser(ws, 'user-1', { type: 'ping' })
    expect(count).toBe(3)
    for (const send of sends) {
      expect(send).toHaveBeenCalledTimes(1)
    }
  })
})
