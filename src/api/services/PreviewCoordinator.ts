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
  agentConfig?: { startingCommand?: string | null } | null;
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

  const rawCommand = match.agentConfig?.startingCommand;
  const startingCommand = rawCommand != null && rawCommand !== '' ? rawCommand : null;

  return {
    channelId: match.id,
    channelName: match.name,
    startingCommand,
  };
}
