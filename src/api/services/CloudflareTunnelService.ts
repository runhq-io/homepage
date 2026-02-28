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

const PUBLIC_PORTS_DOMAIN = process.env.PUBLIC_PORTS_DOMAIN || 'tank.fish';

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
 * Create a DNS CNAME record pointing subdomain.tank.fish → tunnelId.cfargotunnel.com
 */
export async function createDnsRecord(subdomain: string, tunnelId: string): Promise<string> {
  if (!isConfigured()) {
    throw new Error('[CloudflareTunnel] Not configured');
  }

  const res = await fetch(`${zoneApiBase()}/dns_records`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      type: 'CNAME',
      name: `${subdomain}.${PUBLIC_PORTS_DOMAIN}`,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[CloudflareTunnel] Failed to create DNS record: ${res.status} ${text}`);
  }

  const data = (await res.json()) as CloudflareApiResponse<{ id: string }>;
  const dnsRecordId = data.result.id;

  console.log(`[CloudflareTunnel] Created DNS CNAME: ${subdomain}.${PUBLIC_PORTS_DOMAIN} → ${tunnelId}.cfargotunnel.com (record: ${dnsRecordId})`);
  return dnsRecordId;
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDnsRecord(dnsRecordId: string): Promise<void> {
  if (!isConfigured()) {
    console.warn('[CloudflareTunnel] Not configured, skipping deleteDnsRecord');
    return;
  }

  const res = await fetch(`${zoneApiBase()}/dns_records/${dnsRecordId}`, {
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
 * Generate a random 32-byte base64-encoded tunnel secret.
 */
function generateTunnelSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}
