/**
 * Token usage from an Anthropic Messages API response, in its four kinds.
 */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;  // 5-min ephemeral tier; 1h tier not used by RunHQ today
}

interface ModelPrice {
  input: number;   // $ per 1M tokens
  output: number;  // $ per 1M tokens
}

// Anthropic's cache multipliers, uniform across models that support prompt caching.
const CACHE_READ_MULTIPLIER = 0.10;
const CACHE_CREATION_5M_MULTIPLIER = 1.25;

// Per-model pricing. If adding a new model:
//   - confirm prices against https://www.anthropic.com/pricing
//   - keep both aliased variants (dated + '-latest' or shortname) mapped to the same struct
const PRICING: Record<string, ModelPrice> = {
  // Claude 3.5 (legacy but still routable)
  'claude-3-5-sonnet-20241022': { input: 3,   output: 15 },
  'claude-3-5-sonnet-latest':   { input: 3,   output: 15 },
  'claude-3-5-haiku-20241022':  { input: 0.8, output: 4 },
  'claude-3-5-haiku-latest':    { input: 0.8, output: 4 },
  // Claude 3 Opus (legacy)
  'claude-3-opus-20240229': { input: 15, output: 75 },
  'claude-3-opus-latest':   { input: 15, output: 75 },
  // Claude 4.x current
  'claude-sonnet-4-20250514':   { input: 3, output: 15 },
  'claude-sonnet-4-6':          { input: 3, output: 15 },
  'claude-opus-4-20250514':     { input: 5, output: 25 },
  'claude-opus-4-6':            { input: 5, output: 25 },
  'claude-opus-4-7':            { input: 5, output: 25 },
  'claude-haiku-4-5-20251001':  { input: 1, output: 5 },
};

const DEFAULT_PRICING: ModelPrice = { input: 3, output: 15 };

export function pricingForModel(model: string): ModelPrice {
  return PRICING[model] ?? DEFAULT_PRICING;
}

/**
 * Calculate the cost of a single API call in cents (with sub-cent precision).
 * Storage columns are numeric(12,4) — do NOT round here.
 *
 * Unknown models emit a warning and fall back to Sonnet pricing. This keeps
 * us running but flags model lineup drift in logs for the operator.
 */
export function calculateCost(model: string, tokens: TokenCounts): number {
  if (!(model in PRICING)) {
    console.warn(`[pricing] Unknown model '${model}' — falling back to default Sonnet-tier pricing. Update PRICING in src/api/services/pricing.ts.`);
  }
  const price = pricingForModel(model);

  const inputCents         = (tokens.inputTokens         / 1_000_000) * price.input                                * 100;
  const outputCents        = (tokens.outputTokens        / 1_000_000) * price.output                               * 100;
  const cacheReadCents     = (tokens.cacheReadTokens     / 1_000_000) * price.input * CACHE_READ_MULTIPLIER        * 100;
  const cacheCreationCents = (tokens.cacheCreationTokens / 1_000_000) * price.input * CACHE_CREATION_5M_MULTIPLIER * 100;

  return inputCents + outputCents + cacheReadCents + cacheCreationCents;
}
