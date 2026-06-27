/**
 * communityBroadcaster
 *
 * A tiny indirection between the community services (which decide *what* to
 * publish) and the WebSocket server (which knows *how* to deliver it).
 *
 * Why this exists:
 *  - CommunityPointsService is constructed at module-load time (it backs both
 *    the canonical awarding path in WorkspaceTaskService and the staff routes
 *    in HttpServer). At that point the WS server does not yet exist.
 *  - server.ts owns the WS server and registers it here once, at startup.
 *
 * The services publish through `communityPublish`; the WS layer is the sink.
 * Before the sink is registered (or in unit tests) publishing is a safe no-op.
 */

import type { CommunityBroadcastMessage } from '@runhq/server-protocol';

export type CommunityBroadcastSink = (
  topic: string,
  message: CommunityBroadcastMessage,
) => void;

let sink: CommunityBroadcastSink | null = null;

/**
 * Register the delivery sink. Called once from server.ts after the WS server
 * is created. A later call replaces the previous sink.
 */
export function setCommunityBroadcastSink(fn: CommunityBroadcastSink): void {
  sink = fn;
}

/**
 * Publish a community event to a WS topic. No-op if no sink is registered yet.
 */
export function communityPublish(topic: string, message: CommunityBroadcastMessage): void {
  sink?.(topic, message);
}

/** Test-only: clear the registered sink between cases. */
export function __resetCommunityBroadcastSinkForTests(): void {
  sink = null;
}
