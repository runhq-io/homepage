/**
 * Tests for the pure decision helpers used by AutoHealService.
 *
 * These cover the reviewer-flagged "BE decision branches" — specifically
 * that member-reported unreachability does NOT lead to a restart on its own,
 * and that heartbeat-fresh + single-probe-failure triggers a reprobe rather
 * than an immediate restart.
 */

import { describe, it, expect } from 'vitest';
import {
  decideMachineStateAction,
  decideRunningHealthAction,
  isFlapping,
  isHeartbeatFresh,
  FLAP_THRESHOLD,
  HEARTBEAT_STALE_AFTER_MS,
} from './AutoHealDecisions';

describe('decideMachineStateAction', () => {
  it('destroyed / destroying → missing', () => {
    expect(decideMachineStateAction('destroyed')).toBe('missing');
    expect(decideMachineStateAction('destroying')).toBe('missing');
  });

  it('stopped / suspended / starting → wake', () => {
    expect(decideMachineStateAction('stopped')).toBe('wake');
    expect(decideMachineStateAction('suspended')).toBe('wake');
    expect(decideMachineStateAction('starting')).toBe('wake');
  });

  it('running → running (caller proceeds to health probe)', () => {
    expect(decideMachineStateAction('running')).toBe('running');
  });

  it('stopping / creating → transient (client asked to retry later)', () => {
    expect(decideMachineStateAction('stopping')).toBe('transient');
    expect(decideMachineStateAction('creating')).toBe('transient');
  });
});

describe('decideRunningHealthAction', () => {
  it('first probe ok → no_op, regardless of heartbeat', () => {
    expect(decideRunningHealthAction({ firstProbeOk: true, heartbeatFresh: true, secondProbeOk: null })).toBe('no_op');
    expect(decideRunningHealthAction({ firstProbeOk: true, heartbeatFresh: false, secondProbeOk: null })).toBe('no_op');
  });

  it('first probe fails + stale heartbeat → restart immediately', () => {
    expect(decideRunningHealthAction({ firstProbeOk: false, heartbeatFresh: false, secondProbeOk: null })).toBe('restart');
  });

  it('first probe fails + fresh heartbeat → reprobe (do not restart yet)', () => {
    expect(decideRunningHealthAction({ firstProbeOk: false, heartbeatFresh: true, secondProbeOk: null })).toBe('reprobe');
  });

  it('first fails + fresh heartbeat + second probe ok → no_op (transient blip)', () => {
    expect(decideRunningHealthAction({ firstProbeOk: false, heartbeatFresh: true, secondProbeOk: true })).toBe('no_op');
  });

  it('first fails + fresh heartbeat + second probe fails → restart', () => {
    expect(decideRunningHealthAction({ firstProbeOk: false, heartbeatFresh: true, secondProbeOk: false })).toBe('restart');
  });

  it('member-triggered signal alone never restarts without BE-observed probe failure', () => {
    // Represents the "false-positive member with bad WiFi" scenario: BE's
    // confirmation probe shows the workspace is healthy. No restart.
    expect(decideRunningHealthAction({ firstProbeOk: true, heartbeatFresh: false, secondProbeOk: null })).toBe('no_op');
  });
});

describe('isFlapping', () => {
  it('returns false below threshold', () => {
    expect(isFlapping(0)).toBe(false);
    expect(isFlapping(FLAP_THRESHOLD - 1)).toBe(false);
  });

  it('returns true at or above threshold', () => {
    expect(isFlapping(FLAP_THRESHOLD)).toBe(true);
    expect(isFlapping(FLAP_THRESHOLD + 5)).toBe(true);
  });
});

describe('isHeartbeatFresh', () => {
  const NOW = 1_700_000_000_000;

  it('returns false when lastSeen is null', () => {
    expect(isHeartbeatFresh(null, NOW)).toBe(false);
  });

  it('returns true for a recent heartbeat', () => {
    const recent = new Date(NOW - 5_000);
    expect(isHeartbeatFresh(recent, NOW)).toBe(true);
  });

  it('returns true exactly at the staleness boundary - 1ms', () => {
    const edge = new Date(NOW - (HEARTBEAT_STALE_AFTER_MS - 1));
    expect(isHeartbeatFresh(edge, NOW)).toBe(true);
  });

  it('returns false for an old heartbeat', () => {
    const old = new Date(NOW - HEARTBEAT_STALE_AFTER_MS - 1);
    expect(isHeartbeatFresh(old, NOW)).toBe(false);
  });

  it('returns false for a heartbeat exactly at the staleness boundary', () => {
    const edge = new Date(NOW - HEARTBEAT_STALE_AFTER_MS);
    expect(isHeartbeatFresh(edge, NOW)).toBe(false);
  });
});
