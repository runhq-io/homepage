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
    'tauri://localhost', // desktop app webview (macOS/iOS)
    'http://tauri.localhost', // desktop app webview (Windows/Linux)
    'https://tauri.localhost', // desktop app webview (Windows WebView2)
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
  // Public brand-asset page: shows the animated Mercury mark at 512×512.
  const isLogoPage = pathname === '/logo' || pathname === '/logo/';
  const isPublicPage = isLoginPage || isResetPasswordPage || isLogoPage;
  const isApiRoute = pathname.startsWith('/api/');
  const isAuthRoute = pathname.startsWith('/auth/'); // All auth routes (device auth, etc.)
  const isAdminRoute = pathname.startsWith('/admin');
  const isHealthCheck = pathname === '/health' || pathname === '/health/';
  const isOAuthRoute = pathname.startsWith('/oauth');
  const isWidgetScript = pathname === '/widget.js';

  // Handle CORS preflight requests for API and OAuth routes
  if ((isApiRoute || isOAuthRoute) && req.method === 'OPTIONS') {
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
  // - /oauth/* routes handle their own auth flows (OAuth 2.0).
  if (isApiRoute || isAuthRoute || isHealthCheck || isOAuthRoute || isWidgetScript) {
    // Add CORS headers to API and OAuth responses
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

  // /login hosts the real sign-in form. Always allow access to it.
  // If a logged-in user lands on it (e.g. /oauth/authorize bounced them
  // here in the SSO scenario where their cookie is still valid), honor
  // their `returnTo` so the OAuth flow can resume — otherwise dashboard.
  // `returnTo` is validated to same-origin to block open-redirect; any
  // other-origin value falls back to `/`.
  if (isLoginPage && isLoggedIn) {
    const rawReturnTo = req.nextUrl.searchParams.get('returnTo');
    if (rawReturnTo) {
      try {
        const resolved = new URL(rawReturnTo, req.nextUrl.origin);
        if (resolved.origin === req.nextUrl.origin) {
          return NextResponse.redirect(resolved);
        }
      } catch {
        // fall through to dashboard
      }
    }
    return NextResponse.redirect(new URL('/', req.url));
  }

  // Redirect unauthenticated users to /login. Pass `returnTo` so the
  // login form can send them back where they were headed after sign-in.
  if (!isPublicPage && !isLoggedIn) {
    const loginUrl = new URL('/login', req.url);
    // Encode the FULL original URL so /oauth/authorize-style redirects
    // round-trip cleanly. Same-origin enforcement happens in the page +
    // in this middleware on the logged-in branch above.
    loginUrl.searchParams.set('returnTo', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
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
