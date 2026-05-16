/**
 * Canonical ordered list of server-provisioning phases. Single source of
 * truth on the BE. The client mirrors these keys (it cannot import across
 * the be/client deployable boundary) to render labels via i18n, but the
 * ordering and progress fraction are owned here and surfaced through the
 * API so the two never silently diverge on semantics.
 */
export const PROVISION_STEPS = [
  'queued',
  'creating_machine',
  'configuring_network',
  'booting',
  'waiting_for_server',
  'ready',
] as const;

export type ProvisionStep = (typeof PROVISION_STEPS)[number];

/** Terminal failure marker. Not part of the ordered progression. */
export const PROVISION_ERROR_STEP = 'error' as const;

export type ProvisionStepOrError = ProvisionStep | typeof PROVISION_ERROR_STEP;

export function isProvisionStep(value: string): value is ProvisionStepOrError {
  return value === PROVISION_ERROR_STEP || (PROVISION_STEPS as readonly string[]).includes(value);
}

/**
 * Fraction in (0, 1] for the progress bar. `ready` is 1. `error` and any
 * unknown value are 0 (the bar holds; the client renders the error state
 * from the event log instead).
 */
export function provisionProgress(step: string): number {
  const idx = (PROVISION_STEPS as readonly string[]).indexOf(step);
  if (idx === -1) return 0;
  return (idx + 1) / PROVISION_STEPS.length;
}
