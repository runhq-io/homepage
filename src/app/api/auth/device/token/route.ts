import { NextRequest, NextResponse } from 'next/server';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { getDeviceCode, deleteDeviceCode } from '@/lib/deviceAuth';
import { trackGa4WithTimeout } from '@/lib/ga4Telemetry';
import { createToken } from '@/api/auth/jwt';

// POST /api/auth/device/token - Poll for authorization (exchange device code for token)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const device_code = (body as any)?.device_code;
    const clientId = (body as any)?.clientId;
    const ctx = (body as any)?.context;

    if (!device_code) {
      return NextResponse.json({ error: 'missing_device_code' }, { status: 400 });
    }

    const codeData = await getDeviceCode(device_code);

    if (!codeData) {
      return NextResponse.json({ error: 'expired_token' }, { status: 400 });
    }

    if (codeData.expiresAt < Date.now()) {
      await deleteDeviceCode(device_code);
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
    await deleteDeviceCode(device_code);

    // Pre-auth telemetry: device flow completion (conversion).
    const telemetryContext = {
      appVersion: typeof ctx?.appVersion === 'string' ? ctx.appVersion : undefined,
      platform: typeof ctx?.platform === 'string' ? ctx.platform : 'electron',
      locale: typeof ctx?.locale === 'string' ? ctx.locale : undefined,
      userAgent: request.headers.get('user-agent') || undefined,
    };
    await trackGa4WithTimeout({
      clientId: (typeof clientId === 'string' && clientId.length > 0) ? clientId : device_code,
      userId: user.id,
      events: [{ name: 'device_flow_complete', params: { method: 'device_code' } }],
      context: telemetryContext,
    });

    const token = await createToken(user.id);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      token,
    });
  } catch (error) {
    console.error('Token endpoint error:', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
