import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { authorizeDeviceCode, getDeviceCodeByUserCode } from '@/lib/deviceAuth';

export async function POST(request: NextRequest) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { userCode } = await request.json();

  if (!userCode) {
    return NextResponse.json({ error: 'Missing user code' }, { status: 400 });
  }

  const codeData = await getDeviceCodeByUserCode(userCode);

  if (!codeData) {
    return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });
  }

  if (codeData.userId) {
    return NextResponse.json({ error: 'Code already used' }, { status: 400 });
  }

  const userId = session.user.id;
  const success = await authorizeDeviceCode(userCode, userId);

  if (!success) {
    return NextResponse.json({ error: 'Failed to authorize' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
