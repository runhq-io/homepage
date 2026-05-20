import type { RunHQWebSocketServer } from '../api/WebSocketServer'

let server: RunHQWebSocketServer | null = null

export function setWsServer(s: RunHQWebSocketServer) {
  server = s
}

export function wsServer(): RunHQWebSocketServer {
  if (!server) throw new Error('[notifications] WS server not registered')
  return server
}
