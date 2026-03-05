import { NextRequest, NextResponse } from 'next/server';
import { extractUserIdFromToken, createToken } from '@/api/auth/jwt';
import { isAdmin } from '@/lib/adminPolicy';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * GET /api/auth/admin-bridge?token=<jwt>
 *
 * Bridge endpoint for cross-domain admin access.
 * The app client (app.fishtank.bot) redirects admins here with their JWT token.
 * This endpoint verifies the token, checks admin status, sets an HttpOnly cookie
 * on the console domain, and redirects to /admin.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.json({ error: 'Token required' }, { status: 400 });
  }

  const userId = await extractUserIdFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  const userIsAdmin = await isAdmin(userId);
  if (!userIsAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Create a fresh token for the console cookie (don't reuse the one from the URL)
  const freshToken = await createToken(userId);

  const response = NextResponse.redirect(new URL('/admin', request.url));
  response.cookies.set('auth_token', freshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });

  return response;
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = { ...corsHeaders };
  if (origin) {
    const isAllowed = origin.endsWith('.fishtank.bot') || origin.endsWith('.tank.fish') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }
  return new NextResponse(null, { status: 204, headers });
}
