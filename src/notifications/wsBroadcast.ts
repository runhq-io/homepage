import type { RunHQWebSocketServer } from '../api/WebSocketServer'

/**
 * Sends a JSON message to all authenticated sockets for the given userId.
 * Returns the number of sockets the message was sent to.
 */
export function broadcastToUser(ws: RunHQWebSocketServer, userId: string, msg: object): number {
  const sockets = ws.getSocketsForUser(userId)
  const data = JSON.stringify(msg)
  for (const s of sockets) {
    try {
      s.send(data)
    } catch {
      // Ignore individual send errors — a closed socket mid-iteration is harmless.
    }
  }
  return sockets.length
}
