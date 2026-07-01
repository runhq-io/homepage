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

  it('only flags URLs presented as an action — a merely-visible URL is not unsafe', () => {
    // Regression: the guard used to flag ANY visible URL ("Contains links to
    // third-party websites or URLs"), which rejected legitimate bug screenshots
    // that show a URL (address bar, console output). Pattern 3 must be scoped to
    // URLs presented as an ACTION for the agent to take.
    const { system } = buildInjectionGuardMessages({ title: 't', description: 'd' });
    const lower = system.toLowerCase();
    // The old blanket wording must be gone…
    expect(lower).not.toContain('contains links to third-party websites or urls');
    // …replaced by action-scoped wording + an explicit benign-visible-URL carve-out.
    expect(lower).toContain('as an action for the agent to take');
    expect(lower).toContain('visible urls');
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

  it('builds multimodal content when images are provided', () => {
    const { messages } = buildInjectionGuardMessages(
      { title: 'Broken checkout', description: 'Screenshot attached.' },
      [{ mimeType: 'image/png', dataBase64: 'abc123', filename: 'checkout.png' }],
    );
    expect(Array.isArray(messages[0]!.content)).toBe(true);
    const blocks = messages[0]!.content as Array<any>;
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(blocks.some((b) => b.type === 'text' && b.text.includes('checkout.png'))).toBe(true);
    expect(blocks.some((b) => b.type === 'image' && b.source.media_type === 'image/png')).toBe(true);
  });
});
