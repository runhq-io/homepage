/**
 * Pure transcript helpers — no DB. buildTranscript maps persisted rows onto
 * the turn-dispatch wire shape; computePendingProposal derives the latest
 * proposal and its resolution (the workspace needs it to answer the dangling
 * propose_ticket tool_use on rehydration — Anthropic API constraint).
 */
import { describe, it, expect } from 'vitest';
import { buildTranscript, computePendingProposal } from './WidgetChatService';
import type { WidgetChatEventPayload } from '../../db/schema';

const user = (content: string) => ({ role: 'user' as const, content, payload: null });
const agent = (content: string) => ({ role: 'agent' as const, content, payload: null });
const event = (payload: WidgetChatEventPayload) => ({ role: 'event' as const, content: '', payload });

describe('buildTranscript', () => {
  it('maps user/agent rows to content entries and event rows to payload entries', () => {
    expect(buildTranscript([
      user('hi'),
      agent('hello! what broke?'),
      event({ kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' }),
    ])).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'agent', content: 'hello! what broke?' },
      { role: 'event', payload: { kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' } },
    ]);
  });

  it('drops empty content rows and payload-less event rows', () => {
    expect(buildTranscript([
      user(''),
      { role: 'event' as const, content: '', payload: null },
      agent('still here'),
    ])).toEqual([{ role: 'agent', content: 'still here' }]);
  });
});

describe('computePendingProposal', () => {
  it('is null when no proposal was ever made', () => {
    expect(computePendingProposal([user('hi'), agent('hello')])).toBeNull();
  });

  it('marks an unanswered proposal noAction', () => {
    expect(computePendingProposal([
      event({ kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' }),
      user('hmm let me think'),
    ])).toEqual({ toolUseId: 'tu_1', title: 'T', description: 'D', resolution: { noAction: true } });
  });

  it('derives {created, ticketId} from a created proposal_resolved', () => {
    expect(computePendingProposal([
      event({ kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' }),
      event({ kind: 'proposal_resolved', created: true, ticketId: 'tk_1' }),
    ])).toEqual({ toolUseId: 'tu_1', title: 'T', description: 'D', resolution: { created: true, ticketId: 'tk_1' } });
  });

  it('derives {dismissed} from a dismissal', () => {
    expect(computePendingProposal([
      event({ kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_1' }),
      event({ kind: 'proposal_resolved', created: false }),
    ])).toEqual({ toolUseId: 'tu_1', title: 'T', description: 'D', resolution: { dismissed: true } });
  });

  it('the latest proposal wins and only later resolutions count', () => {
    expect(computePendingProposal([
      event({ kind: 'proposal', title: 'A', description: 'a', toolUseId: 'tu_a' }),
      event({ kind: 'proposal_resolved', created: false }),
      event({ kind: 'proposal', title: 'B', description: 'b', toolUseId: 'tu_b' }),
    ])).toEqual({ toolUseId: 'tu_b', title: 'B', description: 'b', resolution: { noAction: true } });
  });
});
