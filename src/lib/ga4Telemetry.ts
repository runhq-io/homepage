// ga4Telemetry
//
// Minimal GA4 Measurement Protocol client for the Portal server.
// Used for pre-auth product telemetry (e.g. device flow start) without
// requiring any unauthenticated telemetry ingestion endpoints.

export type TelemetryEvent = {
  name: string;
  params?: Record<string, unknown>;
};

export type TelemetryContext = {
  appVersion?: string;
  platform?: string;
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
  // IMPORTANT: Never ship a GA4 API secret in the repository.
  // If not configured, telemetry is disabled.
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
    engagement_time_msec: 1,
  } as Record<string, unknown>;

  for (const k of Object.keys(params)) {
    if (params[k] === undefined) delete params[k];
  }

  return { name: event.name, params };
}

export async function trackGa4(req: TrackRequest): Promise<{ enabled: boolean; forwarded: boolean }> {
  const { measurementId, apiSecret, debug } = getGa4Config();
  if (!apiSecret) return { enabled: false, forwarded: false };
  if (!req.clientId) return { enabled: true, forwarded: false };

  const events = Array.isArray(req.events) ? req.events : [];
  const filteredEvents = events
    .filter((e) => e && typeof e.name === 'string' && e.name.length > 0)
    .slice(0, 25)
    .map((e) => buildGaEvent(e, req.context));

  if (filteredEvents.length === 0) return { enabled: true, forwarded: false };

  const payload: Record<string, unknown> = {
    client_id: req.clientId,
    events: filteredEvents,
  };
  if (req.userId) payload.user_id = req.userId;

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
    return { enabled: true, forwarded: resp.ok };
  } catch {
    return { enabled: true, forwarded: false };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fire-and-forget helper that caps how long we await telemetry.
export async function trackGa4WithTimeout(req: TrackRequest, timeoutMs = 250): Promise<void> {
  try {
    const p = trackGa4(req).catch(() => undefined);
    await Promise.race([p, sleep(timeoutMs)]);
  } catch {
    // ignore
  }
}
