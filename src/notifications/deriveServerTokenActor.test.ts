import { describe, it, expect } from 'vitest';
import { deriveServerTokenActor } from './emitTaskNotification';

describe('deriveServerTokenActor', () => {
  // Bug repro: when the user marks their own todo done via the UI, the
  // workspace server proxies it through the server-token route. Before this
  // helper, the route hardcoded `{ type: 'agent' }` — so self-suppression in
  // emitTaskNotification (actor.userId === recipient) never matched, and the
  // user got a notification for their own action. The fix is for the
  // workspace server to include `actingUserId` in the body; this helper turns
  // that wire field into the user actor that drives self-suppression.

  it('returns the agent actor when no actingUserId is present (autonomous agent loop call)', () => {
    expect(deriveServerTokenActor({})).toEqual({ type: 'agent' });
    expect(deriveServerTokenActor({ status: 'done' })).toEqual({ type: 'agent' });
  });

  it('returns the user actor when actingUserId is provided (user-initiated PATCH proxied by the workspace server)', () => {
    const userId = '00000000-0000-0000-0000-aaaabbbb0001';
    expect(deriveServerTokenActor({ actingUserId: userId })).toEqual({ type: 'user', userId });
  });

  it('ignores non-string actingUserId values defensively', () => {
    expect(deriveServerTokenActor({ actingUserId: 42 })).toEqual({ type: 'agent' });
    expect(deriveServerTokenActor({ actingUserId: null })).toEqual({ type: 'agent' });
    expect(deriveServerTokenActor({ actingUserId: '' })).toEqual({ type: 'agent' });
  });

  it('handles bad input shapes without throwing', () => {
    expect(deriveServerTokenActor(null)).toEqual({ type: 'agent' });
    expect(deriveServerTokenActor(undefined)).toEqual({ type: 'agent' });
    expect(deriveServerTokenActor('not an object')).toEqual({ type: 'agent' });
  });
});
