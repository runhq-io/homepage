import { db, adminUsers, users } from '@/db';
import { eq } from 'drizzle-orm';

/**
 * Check if a user is an admin by looking up the admin_users table.
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const result = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId))
    .limit(1);
  return result.length > 0;
}

/**
 * Check if a user is an admin by email (used during sign-in before we have userId on the token).
 */
export async function isAdminByEmail(email: string): Promise<boolean> {
  const result = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .innerJoin(users, eq(users.id, adminUsers.userId))
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return result.length > 0;
}
