import { getDb } from '@/db';
import { oauthClients } from '@/db/schema';
import { hashClientSecret } from '@/lib/oauth';
import { randomBytes } from 'crypto';

async function seedWidgetClient() {
  const clientSecret = randomBytes(32).toString('base64url');
  const secretHash = await hashClientSecret(clientSecret);

  const [client] = await getDb()
    .insert(oauthClients)
    .values({
      name: 'RunHQ Widget',
      secretHash,
      redirectUris: [
        'http://localhost:3000/api/auth/callback',
        'https://www.runhq.io/api/auth/callback',
      ],
      scopes: ['profile'],
      isConfidential: true,
    })
    .returning();

  console.log('OAuth Client created:');
  console.log(`  Client ID: ${client.id}`);
  console.log(`  Client Secret: ${clientSecret}`);
  console.log('  (Save this secret — it cannot be retrieved later)');
  console.log('');
  console.log('Add to widget .env:');
  console.log(`  RUNHQ_OAUTH_CLIENT_ID="${client.id}"`);
  console.log(`  RUNHQ_OAUTH_CLIENT_SECRET="${clientSecret}"`);
  console.log('');
  console.log('Add to be .env:');
  console.log(`  FIRST_PARTY_CLIENT_IDS="${client.id}"`);
}

seedWidgetClient().catch(console.error).finally(() => process.exit());
