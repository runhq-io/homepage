import { describe, it, expect } from 'vitest';
import { PROVISION_STEPS, provisionProgress, isProvisionStep } from './provisionSteps.js';

describe('provisionSteps', () => {
  it('has the expected ordered steps', () => {
    expect(PROVISION_STEPS).toEqual([
      'queued',
      'creating_machine',
      'configuring_network',
      'booting',
      'waiting_for_server',
      'ready',
    ]);
  });

  it('maps each step to an increasing fraction ending at 1', () => {
    expect(provisionProgress('queued')).toBeCloseTo(1 / 6);
    expect(provisionProgress('booting')).toBeCloseTo(4 / 6);
    expect(provisionProgress('ready')).toBe(1);
  });

  it('treats error and unknown steps as 0 progress', () => {
    expect(provisionProgress('error')).toBe(0);
    expect(provisionProgress('bogus')).toBe(0);
  });

  it('isProvisionStep guards the union', () => {
    expect(isProvisionStep('booting')).toBe(true);
    expect(isProvisionStep('error')).toBe(true);
    expect(isProvisionStep('nope')).toBe(false);
  });
});
