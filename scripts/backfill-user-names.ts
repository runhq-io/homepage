import { db, users } from '@/db';
import { isNull } from 'drizzle-orm';

async function backfillUserNames() {
  const result = await db
    .update(users)
    .set({ name: users.username })
    .where(isNull(users.name))
    .returning({ id: users.id, name: users.name });

  console.log(`Backfilled ${result.length} users with name from username`);
  process.exit(0);
}

backfillUserNames().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
