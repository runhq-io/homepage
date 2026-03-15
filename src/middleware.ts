import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/api/auth/jwt';
import { isAdmin } from '@/lib/adminPolicy';

export const runtime = 'nodejs';

// CORS headers for API routes (allows web client access)
function corsHeaders(origin: string | null) {
  const allowedOrigins = [
    'http://localhost:5180', // web client dev
    'http://localhost:5173', // vite default
    'http://127.0.0.1:5180',
    'http://127.0.0.1:5173',
  ];

  // In production, you'd check against actual allowed origins
  const isAllowed = origin && (allowedOrigins.includes(origin) || origin.endsWith('.runhq.io'));

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export default async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const isLoginPage = pathname === '/login';
  const isResetPasswordPage = pathname === '/reset-password';
  const isPublicPage = isLoginPage || isResetPasswordPage;
  const isApiRoute = pathname.startsWith('/api/');
  const isAuthRoute = pathname.startsWith('/auth/'); // All auth routes (device auth, etc.)
  const isAdminRoute = pathname.startsWith('/admin');
  const isHealthCheck = pathname === '/health' || pathname === '/health/';

  // Handle CORS preflight requests for API routes
  if (isApiRoute && req.method === 'OPTIONS') {
    const origin = req.headers.get('origin');
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }

  // Routes that should not require auth.
  // - API routes handle auth (and return JSON/401) themselves.
  // - /auth/* routes handle their own auth flows (device auth, etc.)
  // - /health is used for uptime monitoring and must not redirect.
  if (isApiRoute || isAuthRoute || isHealthCheck) {
    // Add CORS headers to API responses
    const origin = req.headers.get('origin');
    const response = NextResponse.next();
    const headers = corsHeaders(origin);
    Object.entries(headers).forEach(([key, value]) => {
      if (value) response.headers.set(key, value);
    });
    return response;
  }

  // Read JWT from cookie (middleware uses req.cookies, not next/headers cookies())
  const token = req.cookies.get('auth_token')?.value;
  let userId: string | null = null;
  if (token) {
    userId = await verifyToken(token);
  }
  const isLoggedIn = !!userId;

  // /login is now a public landing page (no login form) — always allow it
  // Redirect logged-in users on /login to dashboard
  if (isLoginPage && isLoggedIn) {
    return NextResponse.redirect(new URL('/', req.url));
  }

  // Redirect unauthenticated users to /login (shows "go to app.runhq.io" page)
  if (!isPublicPage && !isLoggedIn) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // Redirect non-admin users away from /admin.
  // (Layout also enforces this; middleware makes the redirect faster/cheaper.)
  if (isAdminRoute && userId) {
    const userIsAdmin = await isAdmin(userId);
    if (!userIsAdmin) {
      return NextResponse.redirect(new URL('/', req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
