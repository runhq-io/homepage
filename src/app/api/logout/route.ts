import { NextResponse } from 'next/server';

/**
 * GET /api/logout
 *
 * Clears the auth_token cookie and redirects to /login.
 */
export async function GET() {
  const response = NextResponse.redirect(new URL('/login', process.env.NEXTAUTH_URL || 'http://localhost:9000'));
  response.cookies.set('auth_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0, // Expire immediately
  });
  return response;
}
