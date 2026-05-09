/**
 * One-time backfill: encrypt every widget project's signing secret.
 *
 * Background — see src/lib/widgetSecretCrypto.ts. The `widget_projects.api_secret_hash`
 * column historically stored the raw HS256 signing key in plaintext. This
 * script rewrites every row so the column holds AES-256-GCM ciphertext under
 * `WIDGET_SECRET_ENCRYPTION_KEY` instead.
 *
 * Usage:
 *   cd be && WIDGET_SECRET_ENCRYPTION_KEY=$(cat .env | grep WIDGET_SECRET | cut -d= -f2) \
 *     pnpm tsx scripts/encrypt-widget-secrets.ts
 *
 * Safe to re-run: rows that already start with `enc:v1:` are skipped. The
 * application reads both formats during the rollout window, so this can
 * run before, after, or while the new code is deploying.
 */

import 'dotenv/config';
import { db } from '../src/db/index';
import { widgetProjects } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { widgetSecretCrypto } from '../src/lib/widgetSecretCrypto';

async function main() {
  if (!widgetSecretCrypto.isConfigured()) {
    console.error('WIDGET_SECRET_ENCRYPTION_KEY is not set. Aborting.');
    process.exit(1);
  }

  const rows = await db
    .select({ id: widgetProjects.id, slug: widgetProjects.slug, apiSecretHash: widgetProjects.apiSecretHash })
    .from(widgetProjects);

  let alreadyEncrypted = 0;
  let migrated = 0;
  let failed = 0;

  for (const row of rows) {
    if (widgetSecretCrypto.isEncrypted(row.apiSecretHash)) {
      alreadyEncrypted++;
      continue;
    }

    try {
      const ciphertext = widgetSecretCrypto.encrypt(row.apiSecretHash);
      await db
        .update(widgetProjects)
        .set({ apiSecretHash: ciphertext, updatedAt: new Date() })
        .where(eq(widgetProjects.id, row.id));
      migrated++;
      console.log(`  encrypted: ${row.id} (${row.slug})`);
    } catch (err) {
      failed++;
      console.error(`  FAILED: ${row.id} (${row.slug}):`, err);
    }
  }

  console.log('');
  console.log(`Total rows:        ${rows.length}`);
  console.log(`Already encrypted: ${alreadyEncrypted}`);
  console.log(`Migrated:          ${migrated}`);
  console.log(`Failed:            ${failed}`);

  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
