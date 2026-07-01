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
  'claude-opus-4-8':            { input: 5, output: 25 },
  'claude-haiku-4-5-20251001':  { input: 1, output: 5 },
  'claude-haiku-4-5':           { input: 1, output: 5 },
};

const DEFAULT_PRICING: ModelPrice = { input: 3, output: 15 };

export function pricingForModel(model: string): ModelPrice {
  return PRICING[model] ?? DEFAULT_PRICING;
}

// ── Model id resolution ──────────────────────────────────────────────────────
//
// Every Claude call (chat, audit, and the `runhq say` / `milestone` leak screen)
// flows through the cloud proxy, which calls resolveModel() before forwarding to
// Anthropic. This is the one central choke point all workspaces share.
//
// Problem it solves: a workspace running a stale image pins a Claude model id
// that Anthropic has since retired. The proxy used to forward it verbatim, so
// Anthropic returned 404 not_found_error. For the screen gate — which fails
// CLOSED on any non-200 — that 404 silently blocked *every* customer message,
// even a plain "hi", with an opaque "screening failed" reason.
//
// Fix: any 4.x id we don't currently serve is routed to the current model of its
// tier (sonnet / opus / haiku). 4.x minors are the same modern family and price,
// so this is safe and idempotent. 3.x legacy ids (still routable, different tier
// and pricing) and non-Claude ids are left untouched.

/** The current, Anthropic-served model for each Claude 4.x tier. */
const CURRENT_MODEL_BY_TIER = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
} as const;

type ModelTier = keyof typeof CURRENT_MODEL_BY_TIER;

/**
 * 4.x ids Anthropic still serves — passed through untouched so an explicitly
 * pinned, valid minor (e.g. claude-opus-4-7) is honoured. Any other
 * `claude-<tier>-4…` id is treated as retired and routed to the tier default.
 * Keep in sync with the "Claude 4.x current" section of PRICING above.
 */
const CURRENT_4X_MODELS = new Set<string>([
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-haiku-4-5',
]);

/**
 * Normalise an incoming model id to one Anthropic currently serves.
 *
 * - current 4.x id            → unchanged
 * - any other claude-<tier>-4… → that tier's current model (heals retired minors)
 * - 3.x legacy / non-Claude    → unchanged
 */
export function resolveModel(model: string): string {
  if (CURRENT_4X_MODELS.has(model)) return model;

  const tier = /^claude-(sonnet|opus|haiku)-4\b/.exec(model)?.[1] as ModelTier | undefined;
  if (tier) {
    const current = CURRENT_MODEL_BY_TIER[tier];
    if (current !== model) {
      console.warn(
        `[resolveModel] Routing retired/dated model '${model}' → '${current}' (${tier} tier). ` +
          'A workspace is likely running a stale image — redeploy it to silence this.',
      );
    }
    return current;
  }

  return model;
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
