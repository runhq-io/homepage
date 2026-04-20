import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db, users, userMfa, userRecoveryCodes } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { verifyPassword } from '@/lib/password';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import {
  verifyTotp,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/mfa';

const regenLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3 });
const getLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function requireUser(request: NextRequest): Promise<string | NextResponse> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }
  const userId = await extractUserIdFromToken(authHeader.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }
  return userId;
}

export async function GET(request: NextRequest) {
  const maybe = await requireUser(request);
  if (maybe instanceof NextResponse) return maybe;
  const userId = maybe;
  if (!getLimiter.check(userId)) return rateLimitResponse(corsHeaders);

  const unused = await db.select({ id: userRecoveryCodes.id })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));

  return NextResponse.json({ remaining: unused.length }, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const maybe = await requireUser(request);
  if (maybe instanceof NextResponse) return maybe;
  const userId = maybe;
  if (!regenLimiter.check(userId)) return rateLimitResponse(corsHeaders);

  let body: { password?: string; code?: string; recoveryCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }
  const usingRecovery = !!body.recoveryCode;
  if (!usingRecovery && !body.code) {
    return NextResponse.json({ error: 'code or recoveryCode required' }, { status: 400, headers: corsHeaders });
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }
  if (!user.mfaEnabled) {
    return NextResponse.json({ error: 'MFA_NOT_ENABLED' }, { status: 409, headers: corsHeaders });
  }

  if (user.passwordHash) {
    if (!body.password) {
      return NextResponse.json({ error: 'password required' }, { status: 400, headers: corsHeaders });
    }
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json({ error: 'INVALID_PASSWORD' }, { status: 401, headers: corsHeaders });
    }
  }

  let secondFactorOk = false;
  if (usingRecovery) {
    const normalized = normalizeRecoveryCode(body.recoveryCode!);
    const unused = await db.select().from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    for (const row of unused) {
      if (await verifyRecoveryCode(normalized, row.codeHash)) {
        const consumed = await db.update(userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(and(
            eq(userRecoveryCodes.id, row.id),
            isNull(userRecoveryCodes.usedAt),
          ))
          .returning({ id: userRecoveryCodes.id });
        if (consumed.length > 0) secondFactorOk = true;
        break;
      }
    }
  } else {
    const [mfaRow] = await db.select().from(userMfa)
      .where(eq(userMfa.userId, userId)).limit(1);
    if (mfaRow) {
      const secret = decryptSecret({
        ciphertext: mfaRow.secretEncrypted,
        iv: mfaRow.secretIv,
        authTag: mfaRow.secretAuthTag,
      });
      if (verifyTotp(secret, body.code!)) secondFactorOk = true;
    }
  }
  if (!secondFactorOk) {
    return NextResponse.json({ error: 'INVALID_MFA_CODE' }, { status: 401, headers: corsHeaders });
  }

  const plainCodes = generateRecoveryCodes(10);
  const hashedCodes = await Promise.all(plainCodes.map(hashRecoveryCode));

  await db.transaction(async (tx) => {
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx.insert(userRecoveryCodes).values(
      hashedCodes.map((codeHash) => ({ userId, codeHash })),
    );
  });

  return NextResponse.json({ recoveryCodes: plainCodes }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
