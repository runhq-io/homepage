import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createToken } from '@/api/auth/jwt';

/**
 * Generate a JWT token for the web client.
 * Called after OAuth completes to give the web client a token.
 */
export async function POST() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const userId = (session.user as any).id;

  if (!userId) {
    console.error('[web-token] Session missing user ID:', session.user);
    return NextResponse.json({ error: 'Session missing user ID' }, { status: 500 });
  }

  const token = await createToken(userId);

  return NextResponse.json({ token });
}
