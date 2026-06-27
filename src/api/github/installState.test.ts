import { describe, it, expect } from 'vitest';
import { signInstallState, verifyInstallState } from './installState.js';

const secret = 'state_secret';

describe('install state', () => {
  it('round-trips a serverId and userId', () => {
    const state = signInstallState('ws_abc', 'user_1', secret);
    expect(verifyInstallState(state, secret)).toEqual({ serverId: 'ws_abc', userId: 'user_1' });
  });
  it('round-trips with a null userId (unknown connector)', () => {
    const state = signInstallState('ws_abc', null, secret);
    expect(verifyInstallState(state, secret)).toEqual({ serverId: 'ws_abc', userId: null });
  });
  it('rejects a tampered payload', () => {
    const state = signInstallState('ws_abc', 'user_1', secret);
    const sig = state.split('.')[1];
    const forged = Buffer.from(JSON.stringify({ serverId: 'ws_evil', userId: 'user_1', iat: Date.now() })).toString('base64url');
    expect(verifyInstallState(`${forged}.${sig}`, secret)).toBeNull();
  });
  it('rejects a bad signature', () => {
    const state = signInstallState('ws_abc', 'user_1', secret);
    expect(verifyInstallState(state, 'other_secret')).toBeNull();
  });
});
