import { describe, it, expect } from 'vitest';
import { inferRegionFromCountry, DEFAULT_REGION } from './regionInference';

describe('inferRegionFromCountry', () => {
  it('routes North America to iad', () => {
    expect(inferRegionFromCountry('US')).toBe('iad');
    expect(inferRegionFromCountry('CA')).toBe('iad');
    expect(inferRegionFromCountry('MX')).toBe('iad');
  });

  it('routes Western Europe to ams', () => {
    expect(inferRegionFromCountry('GB')).toBe('ams');
    expect(inferRegionFromCountry('DE')).toBe('ams');
    expect(inferRegionFromCountry('FR')).toBe('ams');
  });

  it('routes the Middle East to ams', () => {
    expect(inferRegionFromCountry('IL')).toBe('ams');
    expect(inferRegionFromCountry('AE')).toBe('ams');
  });

  it('routes East Asia to nrt', () => {
    expect(inferRegionFromCountry('JP')).toBe('nrt');
    expect(inferRegionFromCountry('KR')).toBe('nrt');
    expect(inferRegionFromCountry('TW')).toBe('nrt');
  });

  it('routes SE Asia + Oceania + India to sin', () => {
    expect(inferRegionFromCountry('SG')).toBe('sin');
    expect(inferRegionFromCountry('AU')).toBe('sin');
    expect(inferRegionFromCountry('IN')).toBe('sin');
  });

  it('normalizes case + whitespace', () => {
    expect(inferRegionFromCountry('us')).toBe('iad');
    expect(inferRegionFromCountry(' JP ')).toBe('nrt');
  });

  it('falls back to the default for unknown/missing codes', () => {
    expect(inferRegionFromCountry(null)).toBe(DEFAULT_REGION);
    expect(inferRegionFromCountry(undefined)).toBe(DEFAULT_REGION);
    expect(inferRegionFromCountry('')).toBe(DEFAULT_REGION);
    expect(inferRegionFromCountry('XX')).toBe(DEFAULT_REGION);
    expect(inferRegionFromCountry('ZZ')).toBe(DEFAULT_REGION);
  });

  it('default region is iad', () => {
    expect(DEFAULT_REGION).toBe('iad');
  });
});
