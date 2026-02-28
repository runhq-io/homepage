// TelemetryService
//
// Server-side forwarding of product telemetry to Google Analytics 4 (GA4)
// via the Measurement Protocol. Keeps GA API secret off the desktop client.

export type TelemetryEvent = {
  name: string;
  params?: Record<string, unknown>;
};

export type TelemetryContext = {
  appVersion?: string;
  platform?: string; // e.g. 'darwin' | 'win32' | 'linux'
  locale?: string;
  userAgent?: string;
};

export type TrackRequest = {
  clientId: string;
  userId?: string;
  events: TelemetryEvent[];
  context?: TelemetryContext;
};

const DEFAULT_MEASUREMENT_ID = 'G-7HZP9XBC3V';

function getGa4Config() {
  const measurementId = process.env.GA4_MEASUREMENT_ID || DEFAULT_MEASUREMENT_ID;
  // IMPORTANT: never ship a default GA4 API secret in the repository.
  // If not configured, telemetry is disabled server-side.
  const apiSecret = process.env.GA4_API_SECRET || '';
  const debug = (process.env.GA4_DEBUG || '').toLowerCase() === 'true';
  return { measurementId, apiSecret, debug };
}

function sanitizeParams(input?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  if (!input) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function buildGaEvent(event: TelemetryEvent, context?: TelemetryContext) {
  const params = {
    ...sanitizeParams(event.params),
    platform: context?.platform || 'unknown',
    app_version: context?.appVersion,
    // GA4 best-practice for MP: include engagement_time_msec on events.
    engagement_time_msec: 1,
  } as Record<string, unknown>;

  // Remove undefined params (GA accepts them, but keep payload clean)
  for (const k of Object.keys(params)) {
    if (params[k] === undefined) delete params[k];
  }

  return { name: event.name, params };
}

/**
 * Forwards telemetry events to GA4.
 *
 * Returns { enabled:false } if GA4_API_SECRET is not configured.
 * This function is intentionally fail-safe: callers can treat failures as non-fatal.
 */
export async function trackGa4(req: TrackRequest): Promise<{ enabled: boolean; forwarded: boolean; status?: number; error?: string }> {
  const { measurementId, apiSecret, debug } = getGa4Config();

  if (!apiSecret) {
    return { enabled: false, forwarded: false };
  }

  if (!req.clientId || typeof req.clientId !== 'string') {
    return { enabled: true, forwarded: false, error: 'missing_client_id' };
  }

  const events = Array.isArray(req.events) ? req.events : [];
  if (events.length === 0) {
    return { enabled: true, forwarded: false, error: 'missing_events' };
  }

  const filteredEvents = events
    .filter((e) => e && typeof e.name === 'string' && e.name.length > 0)
    .slice(0, 25) // GA MP limit: max 25 events per request
    .map((e) => buildGaEvent(e, req.context));

  const payload: Record<string, unknown> = {
    client_id: req.clientId,
    events: filteredEvents,
  };

  // user_id is optional, but helps tie multiple devices/sessions.
  if (req.userId) payload.user_id = req.userId;

  // If caller provides user_properties, allow only primitive values.
  // Keep this conservative to avoid accidentally sending PII.
  // (We don't expose this publicly yet; just future-proofing.)

  const endpointBase = debug
    ? 'https://www.google-analytics.com/debug/mp/collect'
    : 'https://www.google-analytics.com/mp/collect';
  const url = `${endpointBase}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { enabled: true, forwarded: false, status: resp.status, error: text || `ga4_http_${resp.status}` };
    }

    // Debug endpoint returns JSON with validation messages; we ignore by default.
    if (debug) {
      const debugBody = await resp.text().catch(() => '');
      if (debugBody) console.log('[TelemetryService] GA4 debug response:', debugBody.substring(0, 500));
    }

    return { enabled: true, forwarded: true, status: resp.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { enabled: true, forwarded: false, error: message };
  }
}
