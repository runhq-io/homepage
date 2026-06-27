import { describe, it, expect } from 'vitest';
import {
  buildDedupMessages,
  parseDedupVerdict,
  DedupParseError,
} from './dedupCore';

// ---------------------------------------------------------------------------
// parseDedupVerdict
// ---------------------------------------------------------------------------

describe('parseDedupVerdict', () => {
  const VALID_IDS = ['id-1', 'id-2', 'id-3'];

  it('returns { duplicateOf: "id-1" } for an exact JSON match', () => {
    expect(parseDedupVerdict('{"duplicateOf": "id-1"}', VALID_IDS)).toEqual({
      duplicateOf: 'id-1',
    });
  });

  it('returns { duplicateOf: null } when duplicateOf is null', () => {
    expect(parseDedupVerdict('{"duplicateOf": null}', VALID_IDS)).toEqual({
      duplicateOf: null,
    });
  });

  it('extracts JSON when embedded in prose', () => {
    const text = 'Based on my analysis:\n{"duplicateOf": "id-2"}\nThank you.';
    expect(parseDedupVerdict(text, VALID_IDS)).toEqual({ duplicateOf: 'id-2' });
  });

  it('throws DedupParseError when no JSON object found', () => {
    expect(() => parseDedupVerdict('no json here', VALID_IDS)).toThrow(DedupParseError);
  });

  it('throws DedupParseError when JSON is malformed', () => {
    expect(() => parseDedupVerdict('{duplicateOf: "id-1"}', VALID_IDS)).toThrow(DedupParseError);
  });

  it('throws DedupParseError when duplicateOf key is missing', () => {
    expect(() => parseDedupVerdict('{"other": "value"}', VALID_IDS)).toThrow(DedupParseError);
  });

  it('throws DedupParseError when duplicateOf is an invalid (unrecognized) id', () => {
    expect(() => parseDedupVerdict('{"duplicateOf": "unknown-id"}', VALID_IDS)).toThrow(DedupParseError);
  });

  it('throws DedupParseError when duplicateOf is a number (not string or null)', () => {
    expect(() => parseDedupVerdict('{"duplicateOf": 42}', VALID_IDS)).toThrow(DedupParseError);
  });

  it('throws DedupParseError when parsed value is an array (not an object)', () => {
    expect(() => parseDedupVerdict('[]', VALID_IDS)).toThrow(DedupParseError);
  });

  it('returns null when validIds is empty and duplicateOf is null', () => {
    expect(parseDedupVerdict('{"duplicateOf": null}', [])).toEqual({ duplicateOf: null });
  });

  it('throws DedupParseError when validIds is empty and duplicateOf is a non-null string', () => {
    expect(() => parseDedupVerdict('{"duplicateOf": "id-1"}', [])).toThrow(DedupParseError);
  });
});

// ---------------------------------------------------------------------------
// buildDedupMessages
// ---------------------------------------------------------------------------

describe('buildDedupMessages', () => {
  const CANDIDATE = { title: 'Login broken', description: 'SSO login fails with 500 error' };
  const EXISTING = [
    { id: 'id-1', title: 'Sign-in error', description: 'Cannot sign in via SSO' },
    { id: 'id-2', title: 'Dark mode request', description: null },
  ];

  it('returns system + single user message', () => {
    const { system, messages } = buildDedupMessages(CANDIDATE, EXISTING);
    expect(typeof system).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
  });

  it('includes candidate title and description in the message', () => {
    const { messages } = buildDedupMessages(CANDIDATE, EXISTING);
    expect(messages[0]!.content).toContain('Login broken');
    expect(messages[0]!.content).toContain('SSO login fails with 500 error');
  });

  it('includes existing ticket ids and titles', () => {
    const { messages } = buildDedupMessages(CANDIDATE, EXISTING);
    const content = messages[0]!.content;
    expect(content).toContain('id-1');
    expect(content).toContain('Sign-in error');
    expect(content).toContain('id-2');
    expect(content).toContain('Dark mode request');
  });

  it('uses (none provided) for null/missing description in candidate', () => {
    const { messages } = buildDedupMessages({ title: 'Test', description: null }, EXISTING);
    expect(messages[0]!.content).toContain('(none provided)');
  });

  it('uses (none provided) for null description in existing tickets', () => {
    const { messages } = buildDedupMessages(CANDIDATE, EXISTING);
    // id-2 has null description — its entry should say (none provided)
    expect(messages[0]!.content).toContain('(none provided)');
  });

  it('uses (none) when existing list is empty', () => {
    const { messages } = buildDedupMessages(CANDIDATE, []);
    expect(messages[0]!.content).toContain('(none)');
  });

  it('instructs JSON-only output in the system prompt', () => {
    const { system } = buildDedupMessages(CANDIDATE, EXISTING);
    expect(system).toContain('{"duplicateOf"');
    expect(system).toContain('no prose');
  });
});
