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

export type Database = NodePgDatabase<typeof schema>;

export class ServerRegistry {
  constructor(private readonly db: Database) {}

  /**
   * Returns the server's public URL (e.g. the Fly machine URL), or null if
   * the server is unknown or has no URL recorded.
   */
  async getServerUrl(serverId: string): Promise<string | null> {
    const rows = await this.db
      .select({ serverUrl: servers.serverUrl })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return rows[0]?.serverUrl ?? null;
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
