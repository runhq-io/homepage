import { describe, it, expect } from 'vitest';
import {
  signPayload,
  verifySignature,
  isWithinReplayWindow,
  REPLAY_WINDOW_MS,
} from './hmac';

const SECRET = 'test-secret-value';
const TS = new Date('2026-05-04T12:00:00.000Z').toISOString();
const BODY = JSON.stringify({ hello: 'world' });

describe('signPayload', () => {
  it('returns a sha256= prefixed hex digest', () => {
    const sig = signPayload(SECRET, TS, BODY);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('produces the same signature for the same inputs (deterministic)', () => {
    expect(signPayload(SECRET, TS, BODY)).toBe(signPayload(SECRET, TS, BODY));
  });

  it('differs when the body changes', () => {
    const a = signPayload(SECRET, TS, BODY);
    const b = signPayload(SECRET, TS, JSON.stringify({ hello: 'changed' }));
    expect(a).not.toBe(b);
  });

  it('differs when the timestamp changes', () => {
    const a = signPayload(SECRET, TS, BODY);
    const b = signPayload(SECRET, new Date('2026-05-04T13:00:00.000Z').toISOString(), BODY);
    expect(a).not.toBe(b);
  });

  it('differs when the secret changes', () => {
    const a = signPayload(SECRET, TS, BODY);
    const b = signPayload('other-secret', TS, BODY);
    expect(a).not.toBe(b);
  });
});

describe('verifySignature', () => {
  it('accepts a valid roundtrip', () => {
    const sig = signPayload(SECRET, TS, BODY);
    expect(verifySignature(SECRET, TS, BODY, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signPayload(SECRET, TS, BODY);
    expect(verifySignature(SECRET, TS, '{"hello":"tampered"}', sig)).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    const sig = signPayload(SECRET, TS, BODY);
    const wrongTs = new Date('2026-05-04T13:00:00.000Z').toISOString();
    expect(verifySignature(SECRET, wrongTs, BODY, sig)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = signPayload(SECRET, TS, BODY);
    expect(verifySignature('wrong-secret', TS, BODY, sig)).toBe(false);
  });

  it('rejects a signature without the sha256= prefix', () => {
    const sig = signPayload(SECRET, TS, BODY).replace('sha256=', '');
    expect(verifySignature(SECRET, TS, BODY, sig)).toBe(false);
  });

  it('rejects a length-mismatched signature', () => {
    expect(verifySignature(SECRET, TS, BODY, 'sha256=abc')).toBe(false);
  });

  it('rejects an empty signature string', () => {
    expect(verifySignature(SECRET, TS, BODY, '')).toBe(false);
  });
});

describe('isWithinReplayWindow', () => {
  it('accepts a timestamp exactly at the boundary (now)', () => {
    const now = Date.now();
    const ts = new Date(now).toISOString();
    expect(isWithinReplayWindow(ts, now)).toBe(true);
  });

  it('accepts a timestamp within the window', () => {
    const now = Date.now();
    const ts = new Date(now - REPLAY_WINDOW_MS + 1000).toISOString();
    expect(isWithinReplayWindow(ts, now)).toBe(true);
  });

  it('rejects a timestamp outside the window (past)', () => {
    const now = Date.now();
    const ts = new Date(now - REPLAY_WINDOW_MS - 1000).toISOString();
    expect(isWithinReplayWindow(ts, now)).toBe(false);
  });

  it('rejects a timestamp outside the window (future)', () => {
    const now = Date.now();
    const ts = new Date(now + REPLAY_WINDOW_MS + 1000).toISOString();
    expect(isWithinReplayWindow(ts, now)).toBe(false);
  });

  it('rejects a malformed timestamp string', () => {
    expect(isWithinReplayWindow('not-a-date')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isWithinReplayWindow('')).toBe(false);
  });
});
