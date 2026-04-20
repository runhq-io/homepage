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
  previewUrl?: string | null;
  agentConfig?: { startingCommand?: string | null; previewStartCommand?: string | null } | null;
}

function portFromPreviewUrl(previewUrl: string | null | undefined): number | null {
  if (!previewUrl) return null;
  const raw = previewUrl.trim();
  if (!raw) return null;
  // Accept bare "3000", "localhost:3000", or full URLs like "http://localhost:3000/path"
  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    const parsed = new URL(withScheme);
    const fromPort = parseInt(parsed.port, 10);
    if (Number.isFinite(fromPort) && fromPort > 0) return fromPort;
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    return null;
  } catch {
    const m = raw.match(/:(\d{1,5})(\/|$)/);
    if (m) {
      const p = parseInt(m[1], 10);
      if (Number.isFinite(p) && p > 0 && p <= 65535) return p;
    }
    return null;
  }
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
 * Matches by parsing the port out of the channel's `previewUrl` (the canonical
 * field — Channel does not expose a separate `previewPort`). Accepts bare
 * numbers, "localhost:N", and full URLs.
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

  const match = response.data.find((ch) => portFromPreviewUrl(ch.previewUrl) === port);
  if (!match) {
    return null;
  }

  const sc = match.agentConfig?.startingCommand?.trim();
  const psc = match.agentConfig?.previewStartCommand?.trim();
  const startingCommand = sc || psc || null;

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
