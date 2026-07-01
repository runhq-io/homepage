import { describe, it, expect, vi } from 'vitest';
import { calculateCost, pricingForModel, resolveModel } from './pricing';

describe('calculateCost', () => {
  // Anthropic published pricing at spec time, $/MTok:
  //   Opus 4.x:   $5 input / $25 output
  //   Sonnet 4.x: $3 input / $15 output
  //   Haiku 4.5:  $1 input / $5 output
  //   Cache-read: 0.10x input price
  //   Cache-creation (5m ephemeral): 1.25x input price

  it('prices pure input+output for Sonnet', () => {
    // 1M input, 1M output → $3 + $15 = $18 = 1800 cents
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    })).toBeCloseTo(1800, 3);
  });

  it('prices cache-read at 10% of input', () => {
    // 1M cache-read on Sonnet → 1_000_000/1e6 * 3 * 0.10 * 100 = 30 cents
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 1_000_000, cacheCreationTokens: 0,
    })).toBeCloseTo(30, 3);
  });

  it('prices cache-creation at 125% of input', () => {
    // 1M cache-creation on Sonnet → 1e6/1e6 * 3 * 1.25 * 100 = 375 cents
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 1_000_000,
    })).toBeCloseTo(375, 3);
  });

  it('handles mixed token types for Opus', () => {
    // Opus 4.x: input=$5, output=$25
    // 100k input + 50k output + 200k cache-read + 10k cache-creation
    // = 100_000/1e6 * 5 * 100           = 50 cents
    // + 50_000/1e6 * 25 * 100           = 125 cents
    // + 200_000/1e6 * 5 * 0.10 * 100    = 10 cents
    // + 10_000/1e6 * 5 * 1.25 * 100     = 6.25 cents
    // = 191.25 cents
    expect(calculateCost('claude-opus-4-7', {
      inputTokens: 100_000, outputTokens: 50_000,
      cacheReadTokens: 200_000, cacheCreationTokens: 10_000,
    })).toBeCloseTo(191.25, 3);
  });

  it('prices Haiku 4.5 correctly', () => {
    // Haiku 4.5: input=$1, output=$5
    // 1M input + 1M output = $1 + $5 = 600 cents
    expect(calculateCost('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    })).toBeCloseTo(600, 3);
  });

  it('returns 0 for zero tokens', () => {
    expect(calculateCost('claude-sonnet-4-6', {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    })).toBe(0);
  });

  it('falls back to default pricing for unknown model (and warns)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cost = calculateCost('claude-some-future-model', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    expect(cost).toBeCloseTo(300, 3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('claude-some-future-model'));
    warnSpy.mockRestore();
  });
});

describe('pricingForModel', () => {
  it('returns exact match when model is known', () => {
    expect(pricingForModel('claude-opus-4-7')).toEqual({ input: 5, output: 25 });
  });

  it('returns default when model is unknown', () => {
    expect(pricingForModel('claude-unknown-model')).toEqual({ input: 3, output: 15 });
  });
});

describe('pricing + resolveModel alignment', () => {
  // Regression: if resolveModel strips a date suffix, the aliased name MUST be
  // in the pricing table — otherwise we silently fall back to Sonnet pricing
  // and over/undercharge. This test asserts Haiku 4.5 is priced correctly
  // under its post-resolveModel name.

  it('prices claude-haiku-4-5 (post-resolveModel alias) at Haiku rates, not Sonnet', () => {
    // 1M input tokens × $1/MTok × 100 (cents) = 100 cents
    const cost = calculateCost('claude-haiku-4-5', {
      inputTokens: 1_000_000, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    expect(cost).toBeCloseTo(100, 3);
    // Would fail at ~300 if Sonnet default were applied.
  });

  it('claude-haiku-4-5 output is priced at $5/MTok', () => {
    const cost = calculateCost('claude-haiku-4-5', {
      inputTokens: 0, outputTokens: 1_000_000,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    expect(cost).toBeCloseTo(500, 3);
    // Would fail at ~1500 if Sonnet default were applied.
  });

  it('pricingForModel returns Haiku pricing for claude-haiku-4-5', () => {
    expect(pricingForModel('claude-haiku-4-5')).toEqual({ input: 1, output: 5 });
  });
});

describe('resolveModel', () => {
  // Root cause of the "runhq say is blocked" incident: a stale workspace image
  // pinned a now-retired Claude model id for the leak screen. The proxy forwarded
  // it verbatim to Anthropic, which returned 404 not_found_error; the screen gate
  // fails closed on any non-200, so every `runhq say` (even "hi") was blocked.
  // resolveModel is the single central choke point every workspace passes through,
  // so healing retired 4.x ids here auto-fixes stale workspaces without redeploying
  // each one.

  it('passes through current 4.x ids untouched', () => {
    expect(resolveModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveModel('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(resolveModel('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(resolveModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModel('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('heals a retired Sonnet 4.x minor (the incident: 404 not_found_error)', () => {
    // e.g. a workspace pinned Sonnet 4.5, retired by the time it shipped a message.
    expect(resolveModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-6');
    expect(resolveModel('claude-sonnet-4-2')).toBe('claude-sonnet-4-6');
  });

  it('upgrades the legacy dated 4.0 ids (preserves prior MODEL_UPGRADES behavior)', () => {
    expect(resolveModel('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-6');
    expect(resolveModel('claude-opus-4-20250514')).toBe('claude-opus-4-8');
    expect(resolveModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('heals a retired Haiku / Opus 4.x minor to the tier default', () => {
    expect(resolveModel('claude-haiku-4-3-20250101')).toBe('claude-haiku-4-5');
    expect(resolveModel('claude-opus-4-4')).toBe('claude-opus-4-8');
  });

  it('leaves still-routable 3.x legacy ids alone (different tier/pricing)', () => {
    expect(resolveModel('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
    expect(resolveModel('claude-3-opus-20240229')).toBe('claude-3-opus-20240229');
  });

  it('leaves unrecognized non-Claude ids untouched', () => {
    expect(resolveModel('gpt-4o')).toBe('gpt-4o');
    expect(resolveModel('claude-fable-5')).toBe('claude-fable-5');
  });

  it('every tier default it routes to is priced at its real (non-fallback) rate', () => {
    // Guards the regression the alignment block above warns about: a healed id
    // MUST be in the pricing table, or opus/haiku silently bill at Sonnet rates.
    expect(pricingForModel('claude-sonnet-4-6')).toEqual({ input: 3, output: 15 });
    expect(pricingForModel('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(pricingForModel('claude-haiku-4-5')).toEqual({ input: 1, output: 5 });
  });
});
