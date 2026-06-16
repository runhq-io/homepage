/**
 * InjectionGuardService.ts — LLM orchestration for the widget ticket injection
 * guard (pure logic in injectionGuardCore).
 *
 * Screens a widget ticket (and, when present, uploaded images) before any
 * coding agent is auto-assigned. Image uploads are also reviewed before
 * storage when the guard is available; if the guard is unavailable, callers may
 * allow storage only for projects where auto-assignment is disabled and a human
 * will review the ticket. Mirrors the ClarifierService / DedupService pattern:
 * injectable CallModel for tests, real Haiku default in production, bounded
 * timeout/retries.
 *
 * SECURITY POSTURE — fail SAFE for agent handoff. Unlike DedupService
 * (advisory, fails open so it never blocks a real ticket), this guard is a
 * security gate for any ticket that could start an autonomous coding agent.
 * Any model error or unparseable output resolves to `{ safe: false,
 * unavailable: true }` so the caller can block auto-assigned creation or skip
 * auto-assignment. Projects without auto-assignment can still allow ticket
 * creation because a human will review the ticket.
 */

import { MODEL_CALL_TIMEOUT_MS, MODEL_CALL_MAX_RETRIES } from './ClarifierService';
import {
  buildInjectionGuardMessages,
  parseInjectionVerdict,
  type InjectionGuardImage,
  type InjectionGuardMessage,
  type InjectionVerdict,
} from './injectionGuardCore';

export type InjectionGuardCallModel = (args: {
  system: string;
  messages: InjectionGuardMessage[];
}) => Promise<string>;

async function defaultCallModel(args: {
  system: string;
  messages: InjectionGuardMessage[];
}): Promise<string> {
  const { getSettings } = await import('./SettingsService');
  const settings = await getSettings();
  const apiKey = settings.claudeApiKey;
  if (!apiKey) throw new Error('No claudeApiKey configured');

  const anthropic = new (await import('@anthropic-ai/sdk')).default({
    apiKey,
    timeout: MODEL_CALL_TIMEOUT_MS,
    maxRetries: MODEL_CALL_MAX_RETRIES,
  });
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: args.system,
    messages: args.messages,
  });
  const t = resp.content.find((b) => b.type === 'text');
  if (!t || t.type !== 'text') throw new Error('No text block in model response');
  return t.text;
}

export interface InjectionGuardResult extends InjectionVerdict {
  /** True when the verdict is a fail-safe default (model error / parse failure), not a real content judgement. */
  unavailable?: boolean;
}

export async function checkTicket(
  ticket: { title: string; description: string | null },
  deps?: { callModel?: InjectionGuardCallModel; images?: InjectionGuardImage[] },
): Promise<InjectionGuardResult> {
  const callModel = deps?.callModel ?? defaultCallModel;
  try {
    const { system, messages } = buildInjectionGuardMessages(ticket, deps?.images ?? []);
    const text = await callModel({ system, messages });
    return parseInjectionVerdict(text);
  } catch (err) {
    console.warn('[InjectionGuardService] guard unavailable; failing safe (no auto-assign):', err);
    return { safe: false, reasons: ['guard_unavailable'], unavailable: true };
  }
}
