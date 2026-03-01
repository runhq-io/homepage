import { cookies } from 'next/headers';
import { verifyToken } from '@/api/auth/jwt';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { isAdmin } from './adminPolicy';

export interface AuthUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  isAdmin: boolean;
  isActivated: boolean;
}

export interface AuthSession {
  user: AuthUser;
}

/**
 * Drop-in replacement for NextAuth's auth() function.
 * Reads JWT from auth_token HttpOnly cookie, verifies it,
 * and returns the same session shape NextAuth used to return.
 */
export async function auth(): Promise<AuthSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('auth_token')?.value;
  if (!token) return null;

  const userId = await verifyToken(token);
  if (!userId) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return null;

  const userIsAdmin = await isAdmin(userId);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.avatarUrl,
      isAdmin: userIsAdmin,
      isActivated: user.isActivated ?? false,
    },
  };
}
