import { describe, it, expect, vi } from 'vitest';
import { runGateway, type GatewayDeps } from './stateMachine';

function baseDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    isAuthenticated: async () => true,
    channelForPort: async () => ({ channelId: 'ch_a', channelName: 'frontend', startingCommand: 'npm run dev' }),
    wakeServer: async () => ({ success: true, status: 'running' }),
    startChannel: async () => ({ started: true, alreadyStarted: false, terminalSessionId: 'sess_1', bootId: 'b1' }),
    probeReady: async () => true,
    mintToken: async () => 'JWT_TOKEN',
    sleep: async () => {},
    onStep: () => {},
    ...overrides,
  };
}

const baseArgs = {
  target: 'https://3000-m1.preview.runhq.io/path?x=1',
  machineId: 'm1', port: 3000, serverId: 's1',
};

describe('runGateway', () => {
  it('happy path: redirects with token appended and attempts incremented', async () => {
    const steps: string[] = [];
    const result = await runGateway({ ...baseDeps(), ...baseArgs, onStep: (s) => steps.push(s) });
    expect(result.kind).toBe('redirect');
    if (result.kind !== 'redirect') throw new Error();
    const u = new URL(result.url);
    expect(u.searchParams.get('token')).toBe('JWT_TOKEN');
    expect(u.searchParams.get('__pg_attempts')).toBe('1');
    expect(u.searchParams.get('x')).toBe('1'); // preserved
    expect(steps).toContain('auth');
    expect(steps).toContain('wake');
    expect(steps).toContain('start-channel');
    expect(steps).toContain('poll');
    expect(steps).toContain('redirect');
  });

  it('redirect-login when unauthenticated', async () => {
    const result = await runGateway({ ...baseDeps({ isAuthenticated: async () => false }), ...baseArgs });
    expect(result).toEqual({ kind: 'redirect-login' });
  });

  it('no-access when channelForPort throws 403', async () => {
    const deps = baseDeps({ channelForPort: async () => { const e: any = new Error('forbidden'); e.status = 403; throw e; } });
    const result = await runGateway({ ...deps, ...baseArgs });
    expect(result).toEqual({ kind: 'error', reason: 'no-access' });
  });

  it('destroyed when wake returns destroyed', async () => {
    const deps = baseDeps({ wakeServer: async () => ({ success: false, status: 'destroyed' }) });
    const result = await runGateway({ ...deps, ...baseArgs });
    expect(result).toEqual({ kind: 'error', reason: 'destroyed' });
  });

  it('no-access when startChannel throws 403', async () => {
    const deps = baseDeps({ startChannel: async () => { const e: any = new Error(); e.status = 403; throw e; } });
    const result = await runGateway({ ...deps, ...baseArgs });
    expect(result).toEqual({ kind: 'error', reason: 'no-access' });
  });

  it('timeout when probeReady never succeeds', async () => {
    const deps = baseDeps({ probeReady: async () => false });
    const result = await runGateway({ ...deps, ...baseArgs, pollIntervalMs: 1, maxPollMs: 10 });
    expect(result).toEqual({ kind: 'timeout' });
  });

  it('skips start-channel when channel has no startingCommand', async () => {
    const startChannel = vi.fn();
    const deps = baseDeps({
      channelForPort: async () => ({ channelId: 'ch_a', channelName: 'docs', startingCommand: null }),
      startChannel,
    });
    await runGateway({ ...deps, ...baseArgs });
    expect(startChannel).not.toHaveBeenCalled();
  });

  it('skips start-channel when no channel matches the port', async () => {
    const startChannel = vi.fn();
    const deps = baseDeps({ channelForPort: async () => null, startChannel });
    const result = await runGateway({ ...deps, ...baseArgs });
    expect(startChannel).not.toHaveBeenCalled();
    expect(result.kind).toBe('redirect');
  });

  it('increments attempts beyond initial', async () => {
    const result = await runGateway({ ...baseDeps(), ...baseArgs, attempts: 2 });
    if (result.kind !== 'redirect') throw new Error();
    expect(new URL(result.url).searchParams.get('__pg_attempts')).toBe('3');
  });

  it('swallows channelMissing without erroring', async () => {
    const deps = baseDeps({ startChannel: async () => ({ started: false, alreadyStarted: false, terminalSessionId: null, bootId: null, channelMissing: true }) });
    const result = await runGateway({ ...deps, ...baseArgs });
    expect(result.kind).toBe('redirect');
  });
});
