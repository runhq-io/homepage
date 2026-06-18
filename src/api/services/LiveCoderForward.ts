/**
 * LiveCoderForward.ts — Pure screen-and-forward logic for staff live-coder messages.
 *
 * A staff member with the `live_coder` widget permission sends a message into
 * an active widget-chat conversation. This module:
 *   1. Guards against injection attacks via the `screen` dependency.
 *   2. Forwards safe messages to the workspace Runtime Operator via
 *      `sendToWorkspace`.
 *   3. Short-circuits early when there is no assigned job channel yet.
 *
 * The deps pattern (injected screen + sendToWorkspace) keeps the pure logic
 * fully unit-testable without touching the DB, InjectionGuardService, or
 * ServerService.
 */

export interface LiveCoderForwardDeps {
  /** Screen the text for injection attacks. Returns `{ safe, reasons }`. */
  screen: (text: string) => Promise<{ safe: boolean; reasons: string[]; unavailable?: boolean }>;
  /**
   * Forward the message to the workspace Runtime Operator via the HMAC-signed
   * internal route. Returns `{ ok: true }` on success.
   */
  sendToWorkspace: (p: {
    jobChannelId: string;
    text: string;
    actor: { externalUserId: string; name?: string | null };
  }) => Promise<{ ok: boolean }>;
}

export type LiveCoderForwardResult =
  | { status: 'forwarded' }
  | { status: 'flagged' }
  | { status: 'no-job' };

/**
 * Screen a staff live-coder message and, if safe, forward it to the workspace.
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

  const verdict = await deps.screen(input.text);
  if (!verdict.safe) return { status: 'flagged' };

  await deps.sendToWorkspace({
    jobChannelId: input.jobChannelId,
    text: input.text,
    actor: input.actor,
  });

  return { status: 'forwarded' };
}
