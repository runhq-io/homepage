import { lt, and, isNotNull, or } from 'drizzle-orm';
import { getDb, authorizationCodes, oauthTokens } from '@/db';

/**
 * Delete expired/used authorization codes and revoked/expired tokens.
 * Can be called on a schedule or lazily.
 */
export async function cleanupOAuthData(): Promise<{
  codesDeleted: number;
  tokensDeleted: number;
}> {
  const db = getDb();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Delete authorization codes older than 1 hour
  const deletedCodes = await db
    .delete(authorizationCodes)
    .where(lt(authorizationCodes.createdAt, oneHourAgo))
    .returning();

  // Delete revoked tokens older than 24 hours OR expired tokens older than 7 days
  const deletedTokens = await db
    .delete(oauthTokens)
    .where(
      or(
        and(isNotNull(oauthTokens.revokedAt), lt(oauthTokens.revokedAt, oneDayAgo)),
        lt(oauthTokens.expiresAt, sevenDaysAgo)
      )
    )
    .returning();

  return {
    codesDeleted: deletedCodes.length,
    tokensDeleted: deletedTokens.length,
  };
}
