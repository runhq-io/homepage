import { describe, it, expect, beforeAll } from 'vitest';
import { buildMachineHealthRequest } from './HealPoller';
import { initProviders } from './providers/registry';

describe('buildMachineHealthRequest', () => {
  beforeAll(() => {
    // Register the Fly provider so getRoutingInfo is resolvable in tests.
    initProviders();
  });

  it('returns null when serverUrl is missing', () => {
    const r = buildMachineHealthRequest({
      machineId: 'm-1',
      serverUrl: null,
      provider: 'fly',
    });
    expect(r).toBeNull();
  });

  it('targets a specific Fly machine via fly-force-instance-id', () => {
    const r = buildMachineHealthRequest({
      machineId: 'mach-abc',
      serverUrl: 'https://example.fly.dev',
      provider: 'fly',
    });
    expect(r).not.toBeNull();
    // Fly routing replaces the URL with the shared proxy and adds the header;
    // the exact host is determined by FlyProvider (FLY_SERVER_APP_NAME), but
    // the header must be present and equal to the machineId.
    expect(r!.headers['fly-force-instance-id']).toBe('mach-abc');
    expect(r!.url.endsWith('/health')).toBe(true);
  });

  it('appends /health without double slashes when serverUrl has trailing slash', () => {
    const r = buildMachineHealthRequest({
      machineId: 'mach-abc',
      serverUrl: 'https://example.fly.dev/',
      provider: 'fly',
    });
    expect(r).not.toBeNull();
    expect(r!.url).not.toContain('//health');
    expect(r!.url.endsWith('/health')).toBe(true);
  });

  it('falls back to raw serverUrl (no routing header) when machineId is missing', () => {
    const r = buildMachineHealthRequest({
      machineId: null,
      serverUrl: 'https://non-routed.example/',
      provider: 'fly',
    });
    expect(r).not.toBeNull();
    expect(r!.url).toBe('https://non-routed.example/health');
    expect(r!.headers['fly-force-instance-id']).toBeUndefined();
  });
});
