import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import { verifyToken } from './auth/jwt';
import type {
  DesktopToCloudMessage,
  CloudToDesktopMessage,
  AuthMessage,
  ScreenshotMessage,
  ActionResultMessage,
  AuthResultMessage,
  AgentActionMessage,
  StartAgentMessage,
  StopAgentMessage,
  SessionId,
	} from '@fishtank/server-protocol';

interface ConnectedClient {
  ws: WebSocket;
  sessionId: SessionId;
  tempSessionId: SessionId; // Server-generated ID used before auth
  userId?: string;
  authenticated: boolean;
  lastHeartbeat: number;
  // Task subscriptions - which tasks this client is watching
  subscribedTasks: Set<string>;
  // Tasks this client is hosting (streaming from)
  hostedTasks: Set<string>;
}

type MessageHandler = (client: ConnectedClient, message: DesktopToCloudMessage) => void;

export class FishtankWebSocketServer {
  private wss: WSServer;
  private clients: Map<SessionId, ConnectedClient> = new Map();
  private messageHandlers: Map<string, MessageHandler> = new Map();
  // Task subscription tracking: taskId -> Set of client sessionIds
  private taskSubscribers: Map<string, Set<SessionId>> = new Map();
  // Task host tracking: taskId -> host client sessionId
  private taskHosts: Map<string, SessionId> = new Map();

  constructor(opts?: { port?: number; noServer?: boolean }) {
    if (opts?.noServer) {
      this.wss = new WSServer({ noServer: true });
    } else {
      this.wss = new WSServer({ port: opts?.port ?? 8000 });
    }
    this.setupServer();
    this.setupHeartbeat();
    if (opts?.port) {
      console.log(`[WebSocket] Server listening on port ${opts.port}`);
    } else if (opts?.noServer) {
      console.log(`[WebSocket] Server created in noServer mode (will handle upgrades)`);
    }
  }

  /** Handle an HTTP upgrade request (used in noServer mode) */
  handleUpgrade(request: any, socket: any, head: any): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  private setupServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      // Generate a temporary sessionId - will be replaced by client's sessionId after auth
      const tempSessionId = `temp_${nanoid(12)}`;
      const client: ConnectedClient = {
        ws,
        sessionId: tempSessionId, // Will be updated to client's sessionId after auth
        tempSessionId,
        authenticated: false,
        lastHeartbeat: Date.now(),
        subscribedTasks: new Set(),
        hostedTasks: new Set(),
      };

      // Store under temp ID initially - will be moved to client's sessionId after auth
      this.clients.set(tempSessionId, client);
      console.log(`[WebSocket] Client connected (temp): ${tempSessionId}`);

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as DesktopToCloudMessage;
          this.handleMessage(client, message);
        } catch (error) {
          console.error(`[WebSocket] Failed to parse message:`, error);
        }
      });

      ws.on('close', () => {
        // Clean up task subscriptions
        for (const taskId of client.subscribedTasks) {
          this.taskSubscribers.get(taskId)?.delete(client.sessionId);
        }
        // Clean up hosted tasks
        for (const taskId of client.hostedTasks) {
          this.taskHosts.delete(taskId);
        }
        // Delete by actual sessionId (could be temp or client's sessionId after auth)
        this.clients.delete(client.sessionId);
        // Also try to delete by tempSessionId in case it wasn't migrated
        if (client.tempSessionId !== client.sessionId) {
          this.clients.delete(client.tempSessionId);
        }
        console.log(`[WebSocket] Client disconnected: ${client.sessionId}`);
      });

      ws.on('error', (error) => {
        console.error(`[WebSocket] Client error (${client.sessionId}):`, error);
      });
    });
  }

  private setupHeartbeat(): void {
    setInterval(() => {
      const now = Date.now();
      const timeout = 60000; // 60 seconds

      for (const [sessionId, client] of this.clients) {
        if (now - client.lastHeartbeat > timeout) {
          console.log(`[WebSocket] Client timeout: ${sessionId}`);
          client.ws.terminate();
          this.clients.delete(sessionId);
        }
      }
    }, 30000);
  }

  private handleMessage(client: ConnectedClient, message: DesktopToCloudMessage): void {
    client.lastHeartbeat = Date.now();

    // Handle authentication first
    if (message.type === 'auth') {
      this.handleAuth(client, message as AuthMessage).catch((error) => {
        console.error('[WebSocket] Auth handling error:', error);
        const authError: AuthResultMessage = {
          type: 'auth_result',
          success: false,
          error: 'Internal authentication error',
          timestamp: Date.now(),
        };
        this.send(client, authError);
      });
      return;
    }

    // Require authentication for all other messages
    if (!client.authenticated) {
      const authError: AuthResultMessage = {
        type: 'auth_result',
        success: false,
        error: 'Not authenticated',
        timestamp: Date.now(),
      };
      this.send(client, authError);
      return;
    }

    // Handle heartbeat - just acknowledge, no response needed
    if (message.type === 'heartbeat') {
      // Client is alive, no response required
      return;
    }

    // Dispatch to registered handlers
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(client, message);
    } else {
      console.log(`[WebSocket] Unhandled message type: ${message.type}`);
    }
  }

  private async handleAuth(client: ConnectedClient, message: AuthMessage): Promise<void> {
    // Validate token and extract user ID
    let userId: string | null = null;

    if (message.token && message.token.length > 0) {
      // Try JWT verification first (new format)
      userId = await verifyToken(message.token);

      // Fallback: try legacy base64 JSON format for backwards compatibility
      if (!userId) {
        try {
          const decoded = JSON.parse(Buffer.from(message.token, 'base64').toString('utf8'));
          if (decoded.userId && decoded.exp && decoded.exp > Date.now()) {
            console.warn('[WebSocket] Using legacy base64 token - client should update');
            userId = decoded.userId;
          } else if (decoded.userId && decoded.exp) {
            console.warn('[WebSocket] Legacy token expired, rejecting');
          }
        } catch (e) {
          // Token decode failed - reject
          console.log('[WebSocket] Token decode failed, rejecting connection');
        }
      }
    }

    if (userId) {
      client.authenticated = true;
      client.userId = userId;

      // Migrate from temp sessionId to client's persistent sessionId
      // This ensures reconnects use the same sessionId
      const clientSessionId = message.sessionId;
      if (clientSessionId && clientSessionId !== client.sessionId) {
        // Remove old temp entry
        this.clients.delete(client.tempSessionId);

        // Check if there's already a client with this sessionId (reconnection case)
        const existingClient = this.clients.get(clientSessionId);
        if (existingClient) {
          // Close the old connection if it exists
          console.log(`[WebSocket] Replacing existing connection for: ${clientSessionId}`);
          existingClient.ws.terminate();
          this.clients.delete(clientSessionId);
        }

        // Update client's sessionId to the one it provided
        client.sessionId = clientSessionId;

        // Store under client's sessionId
        this.clients.set(clientSessionId, client);
        console.log(`[WebSocket] Client authenticated (migrated to ${clientSessionId})`);
      } else {
        console.log(`[WebSocket] Client authenticated: ${client.sessionId}`);
      }
    }

    const authResult: AuthResultMessage = {
      type: 'auth_result',
      success: !!userId,
      userId: client.userId,
      error: userId ? undefined : 'Invalid or expired token',
      timestamp: Date.now(),
    };
    this.send(client, authResult);
  }

  onMessage(type: string, handler: MessageHandler): void {
    this.messageHandlers.set(type, handler);
  }

  send(client: ConnectedClient, message: CloudToDesktopMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  broadcast(message: CloudToDesktopMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  getClient(sessionId: SessionId): ConnectedClient | undefined {
    return this.clients.get(sessionId);
  }

  getClientByUserId(userId: string): ConnectedClient | undefined {
    for (const client of this.clients.values()) {
      if (client.userId === userId) {
        return client;
      }
    }
    return undefined;
  }

  // ============================================================================
  // Task Subscription Methods (for team collaboration streaming)
  // ============================================================================

  /**
   * Subscribe a client to view a task's real-time stream
   */
  subscribeToTask(clientSessionId: SessionId, taskId: string): boolean {
    const client = this.clients.get(clientSessionId);
    if (!client) return false;

    // Add to task's subscriber set
    if (!this.taskSubscribers.has(taskId)) {
      this.taskSubscribers.set(taskId, new Set());
    }
    this.taskSubscribers.get(taskId)!.add(clientSessionId);
    client.subscribedTasks.add(taskId);

    console.log(`[WebSocket] Client ${clientSessionId} subscribed to task ${taskId}`);
    return true;
  }

  /**
   * Unsubscribe a client from a task's stream
   */
  unsubscribeFromTask(clientSessionId: SessionId, taskId: string): boolean {
    const client = this.clients.get(clientSessionId);
    if (!client) return false;

    this.taskSubscribers.get(taskId)?.delete(clientSessionId);
    client.subscribedTasks.delete(taskId);

    console.log(`[WebSocket] Client ${clientSessionId} unsubscribed from task ${taskId}`);
    return true;
  }

  /**
   * Register a client as the host of a task (streams from this client)
   */
  registerTaskHost(clientSessionId: SessionId, taskId: string): void {
    const client = this.clients.get(clientSessionId);
    if (!client) return;

    this.taskHosts.set(taskId, clientSessionId);
    client.hostedTasks.add(taskId);

    console.log(`[WebSocket] Client ${clientSessionId} is now hosting task ${taskId}`);
  }

  /**
   * Unregister a task host
   */
  unregisterTaskHost(taskId: string): void {
    const hostSessionId = this.taskHosts.get(taskId);
    if (hostSessionId) {
      const client = this.clients.get(hostSessionId);
      if (client) {
        client.hostedTasks.delete(taskId);
      }
      this.taskHosts.delete(taskId);
      console.log(`[WebSocket] Task ${taskId} host unregistered`);
    }
  }

  /**
   * Get the host client for a task
   */
  getTaskHost(taskId: string): ConnectedClient | undefined {
    const hostSessionId = this.taskHosts.get(taskId);
    return hostSessionId ? this.clients.get(hostSessionId) : undefined;
  }

  /**
   * Broadcast a message to all subscribers of a task (excluding the sender)
   */
  broadcastToTaskSubscribers(taskId: string, message: CloudToDesktopMessage, excludeSessionId?: SessionId): void {
    const subscribers = this.taskSubscribers.get(taskId);
    if (!subscribers) return;

    const data = JSON.stringify(message);
    for (const sessionId of subscribers) {
      if (sessionId === excludeSessionId) continue;

      const client = this.clients.get(sessionId);
      if (client && client.authenticated && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  /**
   * Get all subscribers of a task
   */
  getTaskSubscribers(taskId: string): ConnectedClient[] {
    const subscribers = this.taskSubscribers.get(taskId);
    if (!subscribers) return [];

    return Array.from(subscribers)
      .map(sessionId => this.clients.get(sessionId))
      .filter((client): client is ConnectedClient => !!client);
  }

  /**
   * Check if a client is subscribed to a task
   */
  isSubscribedToTask(clientSessionId: SessionId, taskId: string): boolean {
    const client = this.clients.get(clientSessionId);
    return client?.subscribedTasks.has(taskId) ?? false;
  }

  close(): void {
    this.wss.close();
  }
}
