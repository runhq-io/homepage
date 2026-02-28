'use server';

import { auth } from '@/lib/auth';
import { db, systemSettings } from '@/db';
import { eq } from 'drizzle-orm';

export async function updateSettings(settings: Record<string, string>) {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.isAdmin) {
    throw new Error('Unauthorized');
  }

  for (const [key, value] of Object.entries(settings)) {
    const existing = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(systemSettings)
        .set({ value, updatedAt: new Date(), updatedById: user.id })
        .where(eq(systemSettings.key, key));
    } else {
      await db.insert(systemSettings).values({ key, value, updatedById: user.id });
    }
  }
}
