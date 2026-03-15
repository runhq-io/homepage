import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Marketing site may be served from either apex or www.
// Allow both to call this endpoint cross-origin so it can toggle
// the "Waitlist" vs "Console" CTA based on login status.
//
// NOTE: We parse the Origin and validate hostname instead of doing a raw string
// match. This is more robust in case a browser includes an explicit port.
function isAllowedMarketingOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    return url.hostname === 'runhq.io' || url.hostname === 'www.runhq.io';
  } catch {
    return false;
  }
}

function ensureVaryContains(response: NextResponse, value: string) {
  const existing = response.headers.get('Vary');
  if (!existing) {
    response.headers.set('Vary', value);
    return;
  }
  const parts = existing
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.includes(value)) {
    response.headers.set('Vary', `${existing}, ${value}`);
  }
}

function applyCors(request: Request, response: NextResponse) {
  const origin = request.headers.get('origin');
  if (origin && isAllowedMarketingOrigin(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    ensureVaryContains(response, 'Origin');
  }
  return response;
}

export async function OPTIONS(request: Request) {
  const response = new NextResponse(null, { status: 204 });

  // Reflect requested headers for preflight when coming from the allowed origin.
  const reqHeaders = request.headers.get('access-control-request-headers');
  if (reqHeaders) {
    response.headers.set('Access-Control-Allow-Headers', reqHeaders);
  } else {
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.headers.set('Access-Control-Max-Age', '86400');

  return applyCors(request, response);
}

// GET /api/me
// - 200 if logged in
// - 401 if not
export async function GET(request: Request) {
  const session = await auth();
  const user = session?.user as any;

  const response = user
    ? NextResponse.json(
        {
          authenticated: true,
          user: {
            id: user.id,
            email: user.email,
            isAdmin: user.isAdmin,
            isActivated: user.isActivated,
          },
        },
        { status: 200 }
      )
    : NextResponse.json({ authenticated: false }, { status: 401 });

  response.headers.set('Cache-Control', 'no-store');
  return applyCors(request, response);
}
