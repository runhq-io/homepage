/**
 * Maps an ISO 3166-1 alpha-2 country code (e.g. from Cloudflare's `CF-IPCountry`
 * request header) to the nearest Fly region we expose to users. Used during
 * auto-provisioned signup to pick a sensible default without making the user
 * choose. The user can change region later via `/api/servers/:id/change-region`.
 *
 * The five regions match the dropdown in `CreateServerModal`: iad, lax, ams,
 * nrt, sin.
 */

export type FlyRegion = 'iad' | 'lax' | 'ams' | 'nrt' | 'sin';

export const DEFAULT_REGION: FlyRegion = 'iad';

// Country code → preferred Fly region. Conservative grouping by continent /
// geographic latency, mirroring Fly's own region recommendations.
const COUNTRY_TO_REGION: Record<string, FlyRegion> = {
  // US East coast → iad (default for any unmapped Americas country)
  US: 'iad', CA: 'iad', MX: 'iad',
  BR: 'iad', AR: 'iad', CL: 'iad', CO: 'iad', PE: 'iad', VE: 'iad',
  CR: 'iad', PA: 'iad', DO: 'iad', PR: 'iad', UY: 'iad', PY: 'iad', BO: 'iad', EC: 'iad', GT: 'iad', HN: 'iad', NI: 'iad', SV: 'iad',

  // Europe / Middle East / Africa → ams
  GB: 'ams', IE: 'ams', FR: 'ams', DE: 'ams', NL: 'ams', BE: 'ams',
  ES: 'ams', PT: 'ams', IT: 'ams', AT: 'ams', CH: 'ams', LU: 'ams',
  DK: 'ams', FI: 'ams', NO: 'ams', SE: 'ams', IS: 'ams',
  PL: 'ams', CZ: 'ams', SK: 'ams', HU: 'ams', RO: 'ams', BG: 'ams',
  GR: 'ams', HR: 'ams', SI: 'ams', RS: 'ams', LT: 'ams', LV: 'ams', EE: 'ams',
  UA: 'ams', BY: 'ams', RU: 'ams', TR: 'ams',
  IL: 'ams', AE: 'ams', SA: 'ams', QA: 'ams', KW: 'ams', BH: 'ams', OM: 'ams', JO: 'ams', LB: 'ams', EG: 'ams',
  ZA: 'ams', NG: 'ams', KE: 'ams', MA: 'ams', TN: 'ams', DZ: 'ams', GH: 'ams',

  // East Asia → nrt
  JP: 'nrt', KR: 'nrt', CN: 'nrt', TW: 'nrt', HK: 'nrt', MO: 'nrt', MN: 'nrt',

  // South / Southeast Asia / Oceania → sin
  SG: 'sin', IN: 'sin', ID: 'sin', TH: 'sin', VN: 'sin', MY: 'sin', PH: 'sin', KH: 'sin', LA: 'sin', MM: 'sin', BN: 'sin', BD: 'sin', PK: 'sin', LK: 'sin', NP: 'sin',
  AU: 'sin', NZ: 'sin', FJ: 'sin', PG: 'sin',
};

/**
 * Picks the closest exposed Fly region for the given country code. Returns
 * `DEFAULT_REGION` for unknown or missing codes. Input is normalized to
 * uppercase so callers don't have to worry about header casing.
 */
export function inferRegionFromCountry(country: string | null | undefined): FlyRegion {
  if (!country) return DEFAULT_REGION;
  const code = country.trim().toUpperCase();
  return COUNTRY_TO_REGION[code] ?? DEFAULT_REGION;
}
