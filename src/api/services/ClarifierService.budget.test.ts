/**
 * ClarifierService.budget.test.ts — pure invariant guard (no DB / network).
 *
 * The clarifier and dedup Haiku calls run *synchronously inside* the widget
 * `POST /api/widget/tickets/:id/{assign,clarify-answer}` HTTP handlers, which
 * sit behind Cloudflare's ~100s origin-timeout window. The Anthropic SDK's
 * defaults (10-minute request timeout, 2 retries) would let a slow or
 * overloaded model call hang past the gateway, which then returns an opaque
 * 504 with no application-level error to diagnose — the failure mode reported
 * for "assign agent" from the widget.
 *
 * These bounds (set in ClarifierService and reused by DedupService) must keep
 * the worst-case inline model-call chain comfortably under the gateway window
 * so transient Anthropic slowness surfaces as a fast, retryable error instead.
 */
import { describe, it, expect } from 'vitest';
import { MODEL_CALL_TIMEOUT_MS, MODEL_CALL_MAX_RETRIES } from './ClarifierService';

describe('inline model-call budget', () => {
  // Cloudflare's origin-timeout window for console.runhq.io.
  const GATEWAY_WINDOW_MS = 100_000;

  it('bounds each inline model call well under the gateway window', () => {
    expect(MODEL_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MODEL_CALL_MAX_RETRIES).toBeGreaterThanOrEqual(0);
    // A single call's worst case is (retries + 1) attempts at the full timeout.
    const perCallWorstMs = (MODEL_CALL_MAX_RETRIES + 1) * MODEL_CALL_TIMEOUT_MS;
    expect(perCallWorstMs).toBeLessThan(GATEWAY_WINDOW_MS);
  });

  it('keeps the assign-path chain (2 clarifier + 1 dedup) under the gateway window', () => {
    // POST /assign worst case: clarifier parse-retry (up to 2 calls) + dedup (1 call).
    const perCallWorstMs = (MODEL_CALL_MAX_RETRIES + 1) * MODEL_CALL_TIMEOUT_MS;
    const assignChainWorstMs = 3 * perCallWorstMs;
    expect(assignChainWorstMs).toBeLessThan(GATEWAY_WINDOW_MS);
  });
});
