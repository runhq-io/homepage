import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

/**
 * GET /api/auth/me
 *
 * Returns the currently authenticated user from the auth_token cookie.
 * Used by client components that need to check session status.
 */
export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      isAdmin: session.user.isAdmin,
      isActivated: session.user.isActivated,
    },
  });
}
