/**
 * LiveCoderForward.ts — Pure forward logic for staff live-coder messages.
 *
 * A staff member with the `live_coder` widget permission sends a message into
 * an active widget-chat conversation. This module:
 *   1. Forwards the message to the workspace Runtime Operator via
 *      `sendToWorkspace`.
 *   2. Short-circuits early when there is no assigned job channel yet.
 *
 * Inbound live-session messages are NOT AI-screened: the endpoint is already
 * RBAC-gated to holders of the `live_coder` permission, so these are trusted
 * staff instructions to their own coder and are forwarded verbatim. (The
 * injection guard still protects the untrusted intake path — ticket creation
 * and auto-assign — via InjectionGuardService elsewhere.)
 *
 * The deps pattern (injected sendToWorkspace) keeps the pure logic fully
 * unit-testable without touching the DB or ServerService.
 */

export interface LiveCoderForwardDeps {
  /**
   * Forward the message to the workspace Runtime Operator via the HMAC-signed
   * internal route. Returns `{ ok: true }` on success.
   */
  sendToWorkspace: (p: {
    jobChannelId: string;
    text: string;
    actor: { externalUserId: string; name?: string | null };
    conversationId: string;
  }) => Promise<{ ok: boolean }>;
}

export type LiveCoderForwardResult =
  | { status: 'forwarded' }
  | { status: 'no-job' };

/**
 * Forward a staff live-coder message to the workspace.
 *
 * @param input.conversationId  The widget chat conversation id (for tracing).
 * @param input.projectId       The widget project id (for tracing).
 * @param input.widgetUserId    The widget user id of the staff member.
 * @param input.jobChannelId    The workspace channel id of the assigned job.
 *                              Empty string / null → returns `no-job`.
 * @param input.text            The message text to forward.
 * @param input.actor           Identity of the sender for the workspace.
 */
export async function forwardLiveMessage(
  input: {
    conversationId: string;
    projectId: string;
    widgetUserId: string;
    jobChannelId: string;
    text: string;
    actor: { externalUserId: string; name?: string | null };
  },
  deps: LiveCoderForwardDeps,
): Promise<LiveCoderForwardResult> {
  if (!input.jobChannelId) return { status: 'no-job' };

  await deps.sendToWorkspace({
    jobChannelId: input.jobChannelId,
    text: input.text,
    actor: input.actor,
    conversationId: input.conversationId,
  });

  return { status: 'forwarded' };
}
