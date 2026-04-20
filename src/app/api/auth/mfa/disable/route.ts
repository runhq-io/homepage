import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db, users, userMfa, userRecoveryCodes } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { verifyPassword } from '@/lib/password';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import {
  verifyTotp,
  decryptSecret,
  verifyRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/mfa';

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }
  const userId = await extractUserIdFromToken(authHeader.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }
  if (!perUserLimiter.check(userId)) return rateLimitResponse(corsHeaders);

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

  // Password check: required if the account has a password, optional (ignored)
  // for OAuth-only accounts. Users with a password must still provide it.
  if (user.passwordHash) {
    if (!body.password) {
      return NextResponse.json({ error: 'password required' }, { status: 400, headers: corsHeaders });
    }
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json({ error: 'INVALID_PASSWORD' }, { status: 401, headers: corsHeaders });
    }
  }

  // Second factor: either a current TOTP code or a valid unused recovery code.
  let secondFactorOk = false;
  if (usingRecovery) {
    const normalized = normalizeRecoveryCode(body.recoveryCode!);
    const unused = await db.select().from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    for (const row of unused) {
      if (await verifyRecoveryCode(normalized, row.codeHash)) {
        // Atomically consume.
        const consumed = await db.update(userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(and(
            eq(userRecoveryCodes.id, row.id),
            isNull(userRecoveryCodes.usedAt),
          ))
          .returning({ id: userRecoveryCodes.id });
        if (consumed.length > 0) {
          secondFactorOk = true;
        }
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
      if (verifyTotp(secret, body.code!)) {
        secondFactorOk = true;
      }
    }
  }
  if (!secondFactorOk) {
    return NextResponse.json({ error: 'INVALID_MFA_CODE' }, { status: 401, headers: corsHeaders });
  }

  // Tear down MFA fully.
  await db.transaction(async (tx) => {
    await tx.delete(userMfa).where(eq(userMfa.userId, userId));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx.update(users)
      .set({ mfaEnabled: false, mfaEnabledAt: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  });

  return NextResponse.json({ success: true }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
