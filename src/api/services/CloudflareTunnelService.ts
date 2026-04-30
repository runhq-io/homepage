/**
 * Cloudflare Tunnel Service
 *
 * Manages Cloudflare Named Tunnels for public port routing.
 * Each server gets its own tunnel; each public port gets an ingress rule + DNS CNAME.
 * Replaces the old CloudflareKVService + CF Worker proxy approach.
 */

// Read env vars at runtime (not module load time)
function getAccountId(): string | undefined {
  return process.env.CLOUDFLARE_ACCOUNT_ID;
}

function getApiToken(): string | undefined {
  return process.env.CLOUDFLARE_API_TOKEN;
}

function getZoneId(): string | undefined {
  return process.env.CLOUDFLARE_ZONE_ID;
}

function getPublicPortsZoneId(): string | undefined {
  return process.env.CLOUDFLARE_PUBLIC_PORTS_ZONE_ID || getZoneId();
}

const PUBLIC_PORTS_DOMAIN = process.env.PUBLIC_PORTS_DOMAIN || 'runhq.io';

// ============================================================================
// Types
// ============================================================================

export interface TunnelInfo {
  tunnelId: string;
  tunnelToken: string;
}

export interface IngressRule {
  hostname: string;
  service: string;
}

interface CloudflareApiResponse<T = unknown> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

// ============================================================================
// Helpers
// ============================================================================

function getHeaders(): Record<string, string> {
  return {
    'Authorization': `Bearer ${getApiToken()}`,
    'Content-Type': 'application/json',
  };
}

function tunnelApiBase(): string {
  return `https://api.cloudflare.com/client/v4/accounts/${getAccountId()}/cfd_tunnel`;
}

function zoneApiBase(): string {
  return `https://api.cloudflare.com/client/v4/zones/${getZoneId()}`;
}

function publicPortsZoneApiBase(): string {
  return `https://api.cloudflare.com/client/v4/zones/${getPublicPortsZoneId()}`;
}

// ============================================================================
// Public API
// ============================================================================

export function isConfigured(): boolean {
  return !!(getAccountId() && getApiToken() && getZoneId());
}

/**
 * Fetch a connector token for an existing tunnel.
 */
export async function getTunnelToken(tunnelId: string): Promise<string> {
  if (!isConfigured()) {
    throw new Error('[CloudflareTunnel] Not configured');
  }

  const tokenRes = await fetch(`${tunnelApiBase()}/${tunnelId}/token`, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`[CloudflareTunnel] Failed to get tunnel token: ${tokenRes.status} ${text}`);
  }

  const tokenData = (await tokenRes.json()) as CloudflareApiResponse<string>;
  return tokenData.result;
}

/**
 * Create a new Named Tunnel for a server.
 * Returns the tunnel ID and connector token.
 */
export async function createTunnel(serverId: string): Promise<TunnelInfo> {
  if (!isConfigured()) {
    throw new Error('[CloudflareTunnel] Not configured');
  }

  const tunnelName = `server-${serverId}`;
  const tunnelSecret = generateTunnelSecret();

  // Create tunnel
  const createRes = await fetch(tunnelApiBase(), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      name: tunnelName,
      tunnel_secret: tunnelSecret,
    }),
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`[CloudflareTunnel] Failed to create tunnel: ${createRes.status} ${text}`);
  }

  const createData = (await createRes.json()) as CloudflareApiResponse<{ id: string }>;
  const tunnelId = createData.result.id;

  const tunnelToken = await getTunnelToken(tunnelId);

  // Set initial catch-all config (404 for unmatched hostnames)
  await updateIngressConfig(tunnelId, []);

  console.log(`[CloudflareTunnel] Created tunnel ${tunnelId} for server ${serverId}`);
  return { tunnelId, tunnelToken };
}

/**
 * Delete a Named Tunnel. Must have no active connections.
 * Cleans up the tunnel even if it has active connectors by force-deleting.
 */
export async function deleteTunnel(tunnelId: string): Promise<void> {
  if (!isConfigured()) {
    console.warn('[CloudflareTunnel] Not configured, skipping deleteTunnel');
    return;
  }

  // Clean up tunnel config first (remove all ingress rules)
  try {
    await updateIngressConfig(tunnelId, []);
  } catch {
    // Config cleanup is best-effort
  }

  const res = await fetch(`${tunnelApiBase()}/${tunnelId}`, {
    method: 'DELETE',
    headers: getHeaders(),
    body: JSON.stringify({ cascade: true }), // Force delete active connections
  });

  if (!res.ok) {
    const text = await res.text();
    // 404 = already deleted, that's fine
    if (res.status !== 404) {
      throw new Error(`[CloudflareTunnel] Failed to delete tunnel: ${res.status} ${text}`);
    }
  }

  console.log(`[CloudflareTunnel] Deleted tunnel ${tunnelId}`);
}

/**
 * Update the full ingress configuration for a tunnel.
 * Always appends the catch-all 404 rule at the end.
 */
export async function updateIngressConfig(tunnelId: string, rules: IngressRule[]): Promise<void> {
  if (!isConfigured()) {
    throw new Error('[CloudflareTunnel] Not configured');
  }

  const ingress = [
    ...rules.map(r => ({ hostname: r.hostname, service: r.service })),
    { service: 'http_status:404' }, // catch-all
  ];

  const res = await fetch(`${tunnelApiBase()}/${tunnelId}/configurations`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ config: { ingress } }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[CloudflareTunnel] Failed to update ingress config: ${res.status} ${text}`);
  }

  console.log(`[CloudflareTunnel] Updated ingress config for tunnel ${tunnelId} (${rules.length} rules)`);
}

/**
 * Get the current ingress rules for a tunnel (excluding catch-all).
 */
export async function getIngressConfig(tunnelId: string): Promise<IngressRule[]> {
  if (!isConfigured()) {
    return [];
  }

  const res = await fetch(`${tunnelApiBase()}/${tunnelId}/configurations`, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[CloudflareTunnel] Failed to get ingress config: ${res.status} ${text}`);
  }

  const data = (await res.json()) as CloudflareApiResponse<{
    config: { ingress: Array<{ hostname?: string; service: string }> };
  }>;

  // Filter out catch-all rule (no hostname)
  return (data.result.config?.ingress || [])
    .filter(r => r.hostname)
    .map(r => ({ hostname: r.hostname!, service: r.service }));
}

/**
 * Add an ingress rule for a subdomain → port mapping.
 * Fetches current config, appends the new rule, and updates.
 */
export async function addIngressRule(tunnelId: string, subdomain: string, port: number): Promise<void> {
  const currentRules = await getIngressConfig(tunnelId);
  const hostname = `${subdomain}.${PUBLIC_PORTS_DOMAIN}`;

  // Remove existing rule for this hostname if any
  const filtered = currentRules.filter(r => r.hostname !== hostname);
  filtered.push({ hostname, service: `http://localhost:${port}` });

  await updateIngressConfig(tunnelId, filtered);
  console.log(`[CloudflareTunnel] Added ingress rule: ${hostname} → localhost:${port}`);
}

/**
 * Remove an ingress rule for a subdomain.
 */
export async function removeIngressRule(tunnelId: string, subdomain: string): Promise<void> {
  const currentRules = await getIngressConfig(tunnelId);
  const hostname = `${subdomain}.${PUBLIC_PORTS_DOMAIN}`;
  const filtered = currentRules.filter(r => r.hostname !== hostname);

  if (filtered.length === currentRules.length) {
    // Rule didn't exist, nothing to do
    return;
  }

  await updateIngressConfig(tunnelId, filtered);
  console.log(`[CloudflareTunnel] Removed ingress rule: ${hostname}`);
}

/**
 * Internal: create or update a DNS CNAME on a specific Cloudflare zone.
 *
 * `proxied: true` keeps Cloudflare's edge in front (wildcard cert, DDoS,
 * WAF, ACME HTTP-01 forwarding to the origin during cert issuance).
 *
 * Idempotent — if a record with the same name already exists with a
 * different content (e.g. an old cfargotunnel target), this PATCHes it to
 * the new content rather than failing or returning the stale record's ID.
 */
async function createCnameOnZone(
  hostname: string,
  target: string,
  zoneApi: () => string,
  proxied: boolean,
): Promise<string> {
  if (!isConfigured()) {
    throw new Error('[CloudflareTunnel] Not configured');
  }

  const res = await fetch(`${zoneApi()}/dns_records`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      type: 'CNAME',
      name: hostname,
      content: target,
      proxied,
    }),
  });

  if (!res.ok) {
    const data = (await res.json()) as CloudflareApiResponse<unknown>;
    const alreadyExists = data.errors?.some(e => e.code === 81053);

    if (alreadyExists) {
      const existing = await findDnsRecordOnZone(hostname, zoneApi);
      if (existing) {
        const proxiedMismatch = existing.proxied !== proxied;
        if (existing.content === target && !proxiedMismatch) {
          console.log(`[CloudflareTunnel] DNS CNAME already correct for ${hostname} → ${target} (record: ${existing.id})`);
          return existing.id;
        }
        console.log(`[CloudflareTunnel] DNS CNAME exists for ${hostname} → ${existing.content} (proxied=${existing.proxied}), updating to → ${target} (proxied=${proxied})`);
        const patchRes = await fetch(`${zoneApi()}/dns_records/${existing.id}`, {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ content: target, proxied }),
        });
        if (!patchRes.ok) {
          const patchData = (await patchRes.json()) as CloudflareApiResponse<unknown>;
          throw new Error(`[CloudflareTunnel] Failed to update DNS record: ${patchRes.status} ${JSON.stringify(patchData)}`);
        }
        return existing.id;
      }
      console.warn(`[CloudflareTunnel] DNS record exists for ${hostname} but lookup failed, returning sentinel`);
      return `existing:${hostname}`;
    }

    throw new Error(`[CloudflareTunnel] Failed to create DNS record: ${res.status} ${JSON.stringify(data)}`);
  }

  const data = (await res.json()) as CloudflareApiResponse<{ id: string }>;
  const dnsRecordId = data.result.id;

  console.log(`[CloudflareTunnel] Created DNS CNAME: ${hostname} → ${target} (record: ${dnsRecordId})`);
  return dnsRecordId;
}

/**
 * Create or update a DNS CNAME at `<subdomain>.<PUBLIC_PORTS_DOMAIN>`
 * pointing at `target` — the public-ports zone (CLOUDFLARE_PUBLIC_PORTS_ZONE_ID,
 * default runhq.io). Proxied through Cloudflare because this zone routes
 * through cfargotunnel.com, which is CF infrastructure and requires CF in
 * the path. Used by the existing public-ports / cfargotunnel flows.
 */
export async function createCnameRecord(subdomain: string, target: string): Promise<string> {
  const hostname = `${subdomain}.${PUBLIC_PORTS_DOMAIN}`;
  return createCnameOnZone(hostname, target, publicPortsZoneApiBase, /* proxied */ true);
}

/**
 * Create or update a DNS CNAME on the WORKSPACE zone (CLOUDFLARE_ZONE_ID,
 * e.g. tank.fish / staging.tank.fish) at the full hostname `name`, NOT
 * proxied (gray cloud). This matches the existing wildcard
 * `*.<previewDomain>` setup, which is also gray cloud, so Fly's anycast
 * receives the request directly and Fly's per-app TLS cert handles
 * termination — CF's universal SSL doesn't cover two-level wildcards
 * (`*.staging.tank.fish`) and would TLS-handshake-fail if proxied. Used
 * by the Phase 6 per-tenant ingress override.
 *
 * Caller passes the full hostname because the workspace domain is set per
 * environment (PREVIEW_DOMAIN env var on the BE) and may differ from
 * PUBLIC_PORTS_DOMAIN.
 */
export async function createWorkspaceCnameRecord(name: string, target: string): Promise<string> {
  return createCnameOnZone(name, target, zoneApiBase, /* proxied */ false);
}

/**
 * Create a DNS CNAME record pointing subdomain.<PUBLIC_PORTS_DOMAIN> →
 * tunnelId.cfargotunnel.com.
 *
 * @deprecated for per-tenant Fly apps — use `createWorkspaceCnameRecord` to
 * write to the workspace zone with a fly.dev target instead. Kept for the
 * legacy CF Tunnel ingress flow used by existing shared-app workspaces.
 */
export async function createDnsRecord(subdomain: string, tunnelId: string): Promise<string> {
  return createCnameRecord(subdomain, `${tunnelId}.cfargotunnel.com`);
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDnsRecord(dnsRecordId: string): Promise<void> {
  if (!isConfigured()) {
    console.warn('[CloudflareTunnel] Not configured, skipping deleteDnsRecord');
    return;
  }

  const res = await fetch(`${publicPortsZoneApiBase()}/dns_records/${dnsRecordId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });

  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`[CloudflareTunnel] Failed to delete DNS record: ${res.status} ${text}`);
  }

  console.log(`[CloudflareTunnel] Deleted DNS record ${dnsRecordId}`);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Find an existing DNS record by hostname.
 */
async function findDnsRecordOnZone(
  hostname: string,
  zoneApi: () => string,
): Promise<{ id: string; type: string; content: string; proxied: boolean } | null> {
  const res = await fetch(
    `${zoneApi()}/dns_records?name=${encodeURIComponent(hostname)}`,
    { method: 'GET', headers: getHeaders() },
  );

  if (!res.ok) {
    console.warn(`[CloudflareTunnel] findDnsRecord lookup failed for ${hostname}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as CloudflareApiResponse<Array<{ id: string; type: string; content: string; proxied: boolean }>>;
  const record = data.result?.[0];
  if (record) {
    console.log(`[CloudflareTunnel] Found existing ${record.type} record for ${hostname} (id: ${record.id}, content: ${record.content}, proxied: ${record.proxied})`);
  }
  return record || null;
}

/**
 * Generate a random 32-byte base64-encoded tunnel secret.
 */
function generateTunnelSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}
