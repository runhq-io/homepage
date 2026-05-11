/**
 * ServerRegistry — resolves per-server URL and HMAC secret for the workflow
 * cron subsystem.
 *
 * ## Token note
 *
 * The BE never stores the plaintext SERVER_TOKEN (it is passed as an env var
 * to the Fly machine at creation time and is only shown once to the user).
 * What IS stored is `tokenHash = SHA256(SERVER_TOKEN)` as a hex string.
 *
 * Both sides of the HMAC handshake must agree on the same key:
 *   - BE side  : reads `servers.token_hash` from the database.
 *   - Server side: computes `SHA256(SERVER_TOKEN)` at call time.
 *
 * Using the hash as the shared secret is cryptographically sound — it is a
 * 256-bit value derived from the secret, indistinguishable from a random key
 * to an observer who doesn't know SERVER_TOKEN.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import { servers } from '../../db/schema.js';
import { getProvider } from './providers/registry';
import type { ProviderId } from './providers/types';

export type Database = NodePgDatabase<typeof schema>;

export class ServerRegistry {
  constructor(private readonly db: Database) {}

  /**
   * Returns the server's public URL, or null if the server is unknown.
   *
   * For provider-managed servers (Fly, Docker) we prefer the URL derived from
   * `provider.getRoutingInfo()` over the value the server self-reported during
   * registration. Reason: Fly's edge only proxies 80/443 → the machine's
   * internal port, so the `http://<raw-ip>:<internal-port>` URL the runhq
   * server registers on boot via `detectPublicIp()` is unreachable from outside
   * Fly. The provider knows the right shape (`https://<app>.fly.dev`) without
   * having to trust whatever the server wrote into `servers.serverUrl`.
   *
   * `servers.serverUrl` remains the source of truth for self-hosted servers
   * (no provider), where the BE genuinely doesn't know the URL ahead of time.
   *
   * Same overlay pattern as the websocket/job-routing callsite in
   * `HttpServer.ts` — without it the cron scheduler was the only BE→server
   * path trusting the broken stored URL, which made cron dispatch fail with
   * a 10s AbortError on every tick.
   */
  async getServerUrl(serverId: string): Promise<string | null> {
    const rows = await this.db
      .select({
        serverUrl: servers.serverUrl,
        provider: servers.provider,
        machineId: servers.machineId,
        flyAppName: servers.flyAppName,
      })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    // Self-hosted: no provider, trust the registered URL.
    if (!row.provider || !row.machineId) {
      return row.serverUrl ?? null;
    }

    try {
      const provider = getProvider(row.provider as ProviderId);
      const routing = provider.getRoutingInfo(row.machineId, row.flyAppName);
      // `getRoutingInfo` is synchronous and pure — if it returns a non-empty
      // serverUrl we trust it; otherwise fall back to whatever the server
      // self-registered (the only thing we have left).
      return routing.serverUrl || row.serverUrl || null;
    } catch {
      // Unknown / unconfigured provider (e.g. legacy `provider` value) —
      // degrade to the registered URL rather than erroring out the caller.
      return row.serverUrl ?? null;
    }
  }

  /**
   * Returns the HMAC key for this server.
   *
   * This is `servers.token_hash` — the SHA-256 hex digest of the plaintext
   * SERVER_TOKEN that lives on the Fly machine. Both the /be WorkflowCronScheduler
   * (which signs outbound cron-fire requests) and the /be cron-sync handler
   * (which verifies inbound requests) use this value as the shared secret.
   *
   * The runhq server's CronSyncClient must compute the same key by hashing its
   * own SERVER_TOKEN: `createHash('sha256').update(SERVER_TOKEN).digest('hex')`.
   *
   * Returns null when the server is unknown or has never registered a token.
   */
  async getServerToken(serverId: string): Promise<string | null> {
    const rows = await this.db
      .select({ tokenHash: servers.tokenHash })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return rows[0]?.tokenHash ?? null;
  }
}
