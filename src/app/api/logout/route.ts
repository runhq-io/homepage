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
  // Clear the parallel widget cookie. Path/sameSite/secure must match the
  // attributes used at SET time, otherwise the browser leaves the original
  // cookie in place.
  const isProd = process.env.NODE_ENV === 'production';
  response.cookies.set('rw_session', '', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/widget/',
    maxAge: 0,
  });
  return response;
}
