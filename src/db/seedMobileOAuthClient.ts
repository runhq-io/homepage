/**
 * Seed an OAuth 2.0 client row for the RunHQ mobile app
 * (apps/mobile in the runhq repo).
 *
 * Unlike the widget client (seedOAuthClient.ts), the mobile app is a PUBLIC
 * OAuth client: it ships in user-installed binaries on iOS/Android, so it
 * cannot keep a client_secret. Authentication relies entirely on PKCE
 * (RFC 7636) — the BE's token endpoint verifies code_challenge against
 * code_verifier and skips the secret check for non-confidential clients.
 *
 * The single registered redirect URI uses the iOS/Android URL scheme
 * declared in apps/mobile/app.json (expo.scheme = "io.runhq.app"). Any
 * authorize request from another redirect URI is rejected by the BE.
 *
 * Usage:
 *   pnpm tsx src/db/seedMobileOAuthClient.ts
 *
 * Output: the generated client UUID. Paste it into the mobile build as
 *   EXPO_PUBLIC_OAUTH_CLIENT_ID (or expo.extra.oauthClientId in app.json),
 *   then re-build/EAS-update.
 *
 * Idempotent on name: re-running prints the existing row's id instead of
 * creating a duplicate.
 */

import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';

import { getDb } from '@/db';
import { oauthClients } from '@/db/schema';
import { hashClientSecret } from '@/lib/oauth';

const MOBILE_CLIENT_NAME = 'RunHQ Mobile';
const MOBILE_REDIRECT_URI = 'io.runhq.app://oauth/callback';

async function seedMobileClient() {
  const db = getDb();

  // Re-runnable: if a row with this name already exists, surface its id and
  // exit instead of inserting a duplicate (UUIDs would diverge across runs
  // and break mobile builds pinned to the old id).
  const [existing] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.name, MOBILE_CLIENT_NAME))
    .limit(1);

  if (existing) {
    console.log(`OAuth client "${MOBILE_CLIENT_NAME}" already exists:`);
    console.log(`  Client ID:     ${existing.id}`);
    console.log(`  Confidential:  ${existing.isConfidential}`);
    console.log(`  Redirect URIs: ${existing.redirectUris.join(', ')}`);
    console.log('');
    console.log('Set in apps/mobile build:');
    console.log(`  EXPO_PUBLIC_OAUTH_CLIENT_ID="${existing.id}"`);
    return;
  }

  // For a public client, secretHash is never read by the token endpoint
  // (the isConfidential check short-circuits past it). The schema marks
  // the column notNull, so we store a high-entropy random value that
  // could never validate against any plaintext anyone would send. This
  // keeps the schema honest and means a future tightening of the column
  // (e.g. dropping notNull or moving to a separate table for public
  // clients) doesn't need a backfill — the placeholder is already unique.
  const unusableSecret = randomBytes(32).toString('base64url');
  const secretHash = await hashClientSecret(unusableSecret);

  const [client] = await db
    .insert(oauthClients)
    .values({
      name: MOBILE_CLIENT_NAME,
      secretHash,
      redirectUris: [MOBILE_REDIRECT_URI],
      scopes: ['openid', 'profile'],
      isConfidential: false,
    })
    .returning();

  console.log(`OAuth client "${MOBILE_CLIENT_NAME}" created:`);
  console.log(`  Client ID:     ${client.id}`);
  console.log(`  Confidential:  false (PKCE-only)`);
  console.log(`  Redirect URI:  ${MOBILE_REDIRECT_URI}`);
  console.log('');
  console.log('Set in apps/mobile build (e.g. EAS Secret or app.json extra):');
  console.log(`  EXPO_PUBLIC_OAUTH_CLIENT_ID="${client.id}"`);
  console.log('');
  console.log('Optionally add to be .env so the BE treats mobile as first-party:');
  console.log(`  FIRST_PARTY_CLIENT_IDS="${client.id}"`);
}

seedMobileClient()
  .catch((err) => {
    console.error('Failed to seed mobile OAuth client:', err);
    process.exit(1);
  })
  .finally(() => process.exit());
