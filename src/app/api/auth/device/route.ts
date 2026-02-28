import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, users} from '@/db';
import { eq } from 'drizzle-orm';
import { getDeviceCode, setDeviceCode, deleteDeviceCode } from '@/lib/deviceAuth';
import { trackGa4WithTimeout } from '@/lib/ga4Telemetry';

// POST /api/auth/device - Generate a new device code
export async function POST(request: NextRequest) {
  let clientId: string | undefined;
  let ctx: any;
  try {
    const body = await request.json();
    clientId = typeof body?.clientId === 'string' ? body.clientId : undefined;
    ctx = body?.context;
  } catch {
    // ignore (older clients may send no JSON body)
  }

  const deviceCode = nanoid(32);
  const userCode = nanoid(8).toUpperCase();

  await setDeviceCode(deviceCode, {
    userCode,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    interval: 5, // Poll every 5 seconds
  });

  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:9000';

  // Pre-auth telemetry: count device-flow starts as “tried the app”.
  // Fail-safe and time-capped so it never blocks auth UX.
  const telemetryContext = {
    appVersion: typeof ctx?.appVersion === 'string' ? ctx.appVersion : undefined,
    platform: typeof ctx?.platform === 'string' ? ctx.platform : 'electron',
    locale: typeof ctx?.locale === 'string' ? ctx.locale : undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  };
  await trackGa4WithTimeout({
    clientId: clientId || deviceCode,
    events: [{ name: 'device_flow_start', params: { method: 'device_code' } }],
    context: telemetryContext,
  });

  return NextResponse.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${baseUrl}/auth/device`,
    verification_uri_complete: `${baseUrl}/auth/device?code=${userCode}`,
    expires_in: 600,
    interval: 5,
  });
}

// GET /api/auth/device?device_code=xxx - Poll for authorization status
export async function GET(request: NextRequest) {
  const deviceCode = request.nextUrl.searchParams.get('device_code');

  if (!deviceCode) {
    return NextResponse.json({ error: 'missing_device_code' }, { status: 400 });
  }

  const codeData = await getDeviceCode(deviceCode);

  if (!codeData) {
    return NextResponse.json({ error: 'expired_token' }, { status: 400 });
  }

  if (codeData.expiresAt < Date.now()) {
    await deleteDeviceCode(deviceCode);
    return NextResponse.json({ error: 'expired_token' }, { status: 400 });
  }

  if (!codeData.userId) {
    return NextResponse.json({ error: 'authorization_pending' }, { status: 400 });
  }

  // Get user data
  const userResults = await db.select().from(users).where(eq(users.id, codeData.userId)).limit(1);
  const user = userResults[0];

  if (!user) {
    return NextResponse.json({ error: 'invalid_user' }, { status: 400 });
  }

  // Clean up the code
  await deleteDeviceCode(deviceCode);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
    // Generate a simple session token (in production, use JWT)
    token: Buffer.from(JSON.stringify({ userId: user.id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64'),
  });
}
