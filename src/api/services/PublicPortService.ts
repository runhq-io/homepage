/**
 * Public Port Service
 *
 * Manages public port mappings that expose server services via custom subdomains.
 * Each mapping connects a subdomain (e.g., "my-app") to a server port,
 * allowing access via a custom subdomain URL
 *
 * Uses Cloudflare Named Tunnels: each server has a tunnel running inside
 * the container (cloudflared). Port mappings add ingress rules to the tunnel
 * config and create DNS CNAME records pointing to the tunnel.
 */

import { db } from '../../db/index';
import { publicPorts, type PublicPort } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { checkServerPermission, ensureServerTunnelConnector, getServer } from './ServerService';
import * as CloudflareTunnelService from './CloudflareTunnelService';

// ============================================================================
// Constants
// ============================================================================

const MAX_PORTS_PER_SERVER = 5;
const SERVER_PORT = 61987; // Reserved — must not be exposed
const PUBLIC_PORTS_DOMAIN = process.env.PUBLIC_PORTS_DOMAIN || 'runhq.io';
const RESERVED_SUBDOMAINS = ['www', 'api', 'app', 'mail', 'admin', 'console', 'status', 'runhq'];
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

// ============================================================================
// Validation
// ============================================================================

function validateSubdomain(subdomain: string): string | null {
  if (!subdomain || subdomain.length < 3) {
    return 'Subdomain must be at least 3 characters';
  }
  if (subdomain.length > 63) {
    return 'Subdomain must be at most 63 characters';
  }
  if (!SUBDOMAIN_REGEX.test(subdomain)) {
    return 'Subdomain must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number';
  }
  if (RESERVED_SUBDOMAINS.includes(subdomain)) {
    return `Subdomain "${subdomain}" is reserved`;
  }
  return null;
}

function validatePort(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Port must be an integer between 1 and 65535';
  }
  if (port === SERVER_PORT) {
    return `Port ${SERVER_PORT} is reserved for the server`;
  }
  return null;
}

// ============================================================================
// Public API
// ============================================================================

export async function listPortMappings(serverId: string): Promise<PublicPort[]> {
  return db
    .select()
    .from(publicPorts)
    .where(eq(publicPorts.serverId, serverId));
}

export async function checkSubdomainAvailability(subdomain: string): Promise<{ available: boolean; error?: string }> {
  const validationError = validateSubdomain(subdomain);
  if (validationError) {
    return { available: false, error: validationError };
  }

  const [existing] = await db
    .select({ id: publicPorts.id })
    .from(publicPorts)
    .where(eq(publicPorts.subdomain, subdomain))
    .limit(1);

  return { available: !existing };
}

export async function createPortMapping(
  serverId: string,
  userId: string,
  input: { subdomain: string; port: number; label?: string }
): Promise<{ success: boolean; portMapping?: PublicPort; error?: string }> {
  // Validate subdomain
  const subdomainError = validateSubdomain(input.subdomain);
  if (subdomainError) {
    return { success: false, error: subdomainError };
  }

  // Validate port
  const portError = validatePort(input.port);
  if (portError) {
    return { success: false, error: portError };
  }

  // Check permission (owner or admin)
  const hasPermission = await checkServerPermission(serverId, userId, ['owner', 'admin']);
  if (!hasPermission) {
    return { success: false, error: 'Only server owner or admin can manage port mappings' };
  }

  // Check limit
  const existing = await listPortMappings(serverId);
  if (existing.length >= MAX_PORTS_PER_SERVER) {
    return { success: false, error: `Maximum ${MAX_PORTS_PER_SERVER} port mappings per server` };
  }

  // Check subdomain availability
  const availability = await checkSubdomainAvailability(input.subdomain);
  if (!availability.available) {
    return { success: false, error: availability.error || 'Subdomain is already taken' };
  }

  // Ensure server tunnel exists (legacy backfill for older servers).
  let tunnelId: string;
  try {
    const tunnel = await ensureServerTunnelConnector(serverId);
    if (!tunnel) {
      return { success: false, error: 'Server not found or not remote' };
    }
    tunnelId = tunnel.tunnelId;
  } catch (error) {
    console.error(`[PublicPortService] Failed to ensure tunnel for server ${serverId}:`, error);
    return { success: false, error: 'Failed to prepare server tunnel' };
  }

  // Add ingress rule + DNS record via Cloudflare
  let dnsRecordId: string | null = null;
  try {
    await CloudflareTunnelService.addIngressRule(tunnelId, input.subdomain, input.port);
    dnsRecordId = await CloudflareTunnelService.createDnsRecord(input.subdomain, tunnelId);
  } catch (error) {
    console.error(`[PublicPortService] Failed to configure tunnel for "${input.subdomain}":`, error);
    // Clean up partial state
    try {
      await CloudflareTunnelService.removeIngressRule(tunnelId, input.subdomain);
    } catch { /* best effort */ }
    if (dnsRecordId) {
      try {
        await CloudflareTunnelService.deleteDnsRecord(dnsRecordId);
      } catch { /* best effort */ }
    }
    return { success: false, error: 'Failed to configure tunnel routing' };
  }

  // Insert into DB (with dnsRecordId for cleanup)
  const [portMapping] = await db
    .insert(publicPorts)
    .values({
      serverId,
      subdomain: input.subdomain,
      port: input.port,
      label: input.label || null,
      dnsRecordId,
    })
    .returning();

  console.log(`[PublicPortService] Created port mapping: ${input.subdomain}.${PUBLIC_PORTS_DOMAIN} -> ${serverId}:${input.port}`);
  return { success: true, portMapping };
}

export async function deletePortMapping(
  serverId: string,
  userId: string,
  portMappingId: string
): Promise<{ success: boolean; error?: string }> {
  // Check permission
  const hasPermission = await checkServerPermission(serverId, userId, ['owner', 'admin']);
  if (!hasPermission) {
    return { success: false, error: 'Only server owner or admin can manage port mappings' };
  }

  // Find the mapping
  const [mapping] = await db
    .select()
    .from(publicPorts)
    .where(and(eq(publicPorts.id, portMappingId), eq(publicPorts.serverId, serverId)))
    .limit(1);

  if (!mapping) {
    return { success: false, error: 'Port mapping not found' };
  }

  // Delete from DB first
  await db.delete(publicPorts).where(eq(publicPorts.id, portMappingId));

  // Clean up tunnel ingress rule + DNS record
  const server = await getServer(serverId);
  if (server?.tunnelId) {
    try {
      await CloudflareTunnelService.removeIngressRule(server.tunnelId, mapping.subdomain);
    } catch (error) {
      console.error(`[PublicPortService] Failed to remove ingress rule for "${mapping.subdomain}":`, error);
    }
  }

  if (mapping.dnsRecordId) {
    try {
      await CloudflareTunnelService.deleteDnsRecord(mapping.dnsRecordId);
    } catch (error) {
      console.error(`[PublicPortService] Failed to delete DNS record for "${mapping.subdomain}":`, error);
    }
  }

  console.log(`[PublicPortService] Deleted port mapping: ${mapping.subdomain}`);
  return { success: true };
}

export async function deleteAllPortMappings(serverId: string): Promise<void> {
  const mappings = await listPortMappings(serverId);

  if (mappings.length === 0) return;

  // Delete all from DB
  await db.delete(publicPorts).where(eq(publicPorts.serverId, serverId));

  // Clean up DNS records
  for (const mapping of mappings) {
    if (mapping.dnsRecordId) {
      try {
        await CloudflareTunnelService.deleteDnsRecord(mapping.dnsRecordId);
      } catch (error) {
        console.error(`[PublicPortService] Failed to delete DNS record for "${mapping.subdomain}":`, error);
      }
    }
  }

  // Clear all ingress rules for the tunnel (reset to empty)
  const server = await getServer(serverId);
  if (server?.tunnelId) {
    try {
      await CloudflareTunnelService.updateIngressConfig(server.tunnelId, []);
    } catch (error) {
      console.error(`[PublicPortService] Failed to clear ingress rules for server ${serverId}:`, error);
    }
  }

  console.log(`[PublicPortService] Deleted all ${mappings.length} port mappings for server ${serverId}`);
}
