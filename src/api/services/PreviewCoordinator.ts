/**
 * PreviewCoordinator
 *
 * Pure functional helpers used by the preview gateway to map running
 * preview ports back to the channel (and its startingCommand) that owns them.
 */

import type { Server } from '../../db/schema';
import { fetchFromServer } from './ServerService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoteChannel {
  id: string;
  name: string;
  previewPort?: number | null;
  agentConfig?: { startingCommand?: string | null; previewStartCommand?: string | null } | null;
}

interface RemoteChannelsResponse {
  success: boolean;
  data: RemoteChannel[];
}

export interface PreviewChannelMatch {
  channelId: string;
  channelName: string;
  startingCommand: string | null;
}

export interface StartChannelResult {
  started: boolean;
  alreadyStarted: boolean;
  terminalSessionId: string | null;
  bootId: string | null;
  channelMissing?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up the channel bound to a specific preview port on a running server.
 *
 * Returns a {@link PreviewChannelMatch} when a channel whose `previewPort`
 * equals `port` is found, or `null` when no such channel exists.
 *
 * Errors from `fetchFromServer` (e.g. server unreachable) are propagated
 * to the caller — this function does not swallow them.
 */
export async function channelForPort(args: {
  server: Server;
  userId: string;
  port: number;
}): Promise<PreviewChannelMatch | null> {
  const { server, userId, port } = args;

  const response = await fetchFromServer<RemoteChannelsResponse>(
    server,
    userId,
    '/api/channels',
    { method: 'GET' },
  );

  const match = response.data.find((ch) => ch.previewPort === port);
  if (!match) {
    return null;
  }

  const rawCommand = match.agentConfig?.startingCommand || match.agentConfig?.previewStartCommand;
  const startingCommand = rawCommand != null && rawCommand !== '' ? rawCommand : null;

  return {
    channelId: match.id,
    channelName: match.name,
    startingCommand,
  };
}

/**
 * Probe whether the Fly machine's preview port is ready.
 *
 * Returns `true` when the machine reports `ready: true` for the given port.
 * Returns `false` on any error (network failure, machine offline, etc.) so the
 * caller can treat those as "not yet ready" rather than a hard failure.
 */
export async function probeReady(args: {
  server: Server;
  userId: string;
  port: number;
}): Promise<boolean> {
  try {
    const result = await fetchFromServer<{ ready?: boolean }>(
      args.server,
      args.userId,
      `/__preview/health?port=${args.port}`,
      { timeoutMs: 2000 },
    );
    return result.ready === true;
  } catch {
    return false;
  }
}

/**
 * Fetch the last N lines of terminal output for a channel from the machine.
 *
 * Returns null when the machine reports HTTP 404 (no session for the channel).
 * All other errors are propagated to the caller.
 */
export async function recentOutput(args: {
  server: Server;
  userId: string;
  channelId: string;
  lines?: number;
}): Promise<{ output: string; sessionId: string | null } | null> {
  try {
    const lines = Math.min(Math.max(args.lines ?? 50, 1), 500);
    return await fetchFromServer<{ output: string; sessionId: string | null }>(
      args.server,
      args.userId,
      `/__preview/recent-output?channelId=${encodeURIComponent(args.channelId)}&lines=${lines}`,
      { timeoutMs: 3000 },
    );
  } catch (err: any) {
    if (String(err?.message || '').includes('HTTP 404')) return null;
    throw err;
  }
}

/**
 * Instruct the machine to start the channel's Start Command.
 *
 * On success the machine's response shape is relayed directly.
 * On HTTP 404 (channel not found / no startingCommand) the result
 * surfaces `channelMissing: true` so callers can handle it gracefully.
 * All other errors (network, non-404 HTTP) are propagated.
 */
export async function startChannel(args: {
  server: Server;
  userId: string;
  channelId: string;
  force?: boolean;
}): Promise<StartChannelResult> {
  const { server, userId, channelId, force } = args;

  try {
    return await fetchFromServer<StartChannelResult>(
      server,
      userId,
      '/__preview/start-channel',
      { method: 'POST', body: { channelId, force: force ?? false } },
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'Server responded with HTTP 404') {
      return {
        started: false,
        alreadyStarted: false,
        terminalSessionId: null,
        bootId: null,
        channelMissing: true,
      };
    }
    throw err;
  }
}
