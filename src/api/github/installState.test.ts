import { describe, it, expect } from 'vitest';
import { signInstallState, verifyInstallState } from './installState.js';

const secret = 'state_secret';

describe('install state', () => {
  it('round-trips a serverId', () => {
    const state = signInstallState('ws_abc', secret);
    expect(verifyInstallState(state, secret)).toBe('ws_abc');
  });
  it('rejects a tampered payload', () => {
    const state = signInstallState('ws_abc', secret);
    const sig = state.split('.')[1];
    const forged = Buffer.from(JSON.stringify({ serverId: 'ws_evil', iat: Date.now() })).toString('base64url');
    expect(verifyInstallState(`${forged}.${sig}`, secret)).toBeNull();
  });
  it('rejects a bad signature', () => {
    const state = signInstallState('ws_abc', secret);
    expect(verifyInstallState(state, 'other_secret')).toBeNull();
  });
});
