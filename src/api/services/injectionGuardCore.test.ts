import { describe, it, expect } from 'vitest';
import {
  buildInjectionGuardMessages,
  parseInjectionVerdict,
  InjectionGuardParseError,
} from './injectionGuardCore';

describe('parseInjectionVerdict', () => {
  it('parses a safe verdict', () => {
    expect(parseInjectionVerdict('{"safe":true,"reasons":[]}')).toEqual({
      safe: true,
      reasons: [],
    });
  });

  it('parses an unsafe verdict with reasons', () => {
    expect(
      parseInjectionVerdict('{"safe":false,"reasons":["asks for an API key","contains a third-party link"]}'),
    ).toEqual({
      safe: false,
      reasons: ['asks for an API key', 'contains a third-party link'],
    });
  });

  it('tolerates a ```json code fence and surrounding prose', () => {
    const text = 'Here is my verdict:\n```json\n{"safe": false, "reasons": ["embeds code to run"]}\n```\nThanks.';
    expect(parseInjectionVerdict(text)).toEqual({
      safe: false,
      reasons: ['embeds code to run'],
    });
  });

  it('defaults reasons to [] when safe and reasons omitted', () => {
    expect(parseInjectionVerdict('{"safe":true}')).toEqual({ safe: true, reasons: [] });
  });

  it('throws InjectionGuardParseError when no JSON object is present', () => {
    expect(() => parseInjectionVerdict('I think this looks fine.')).toThrow(InjectionGuardParseError);
  });

  it('throws when `safe` is missing', () => {
    expect(() => parseInjectionVerdict('{"reasons":[]}')).toThrow(InjectionGuardParseError);
  });

  it('throws when `safe` is not a boolean', () => {
    expect(() => parseInjectionVerdict('{"safe":"yes"}')).toThrow(InjectionGuardParseError);
  });

  it('coerces non-string reason entries away (keeps only strings)', () => {
    expect(parseInjectionVerdict('{"safe":false,"reasons":["ok",5,null,"two"]}')).toEqual({
      safe: false,
      reasons: ['ok', 'two'],
    });
  });
});

describe('buildInjectionGuardMessages', () => {
  it('names the four red flags in the system prompt', () => {
    const { system } = buildInjectionGuardMessages({ title: 't', description: 'd' });
    const lower = system.toLowerCase();
    expect(lower).toContain('secret');
    expect(lower).toContain('code');
    expect(lower).toContain('link');
    expect(lower).toContain('api');
  });

  it('puts the ticket title and description in the user message', () => {
    const { messages } = buildInjectionGuardMessages({
      title: 'Dark mode toggle',
      description: 'Please add a dark mode toggle to settings.',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toContain('Dark mode toggle');
    expect(messages[0]!.content).toContain('dark mode toggle to settings');
  });

  it('handles a null description without crashing', () => {
    const { messages } = buildInjectionGuardMessages({ title: 'Bug', description: null });
    expect(messages[0]!.content).toContain('Bug');
  });
});
