import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull, count, ne } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db, users, userPasskeys, userMfa, userRecoveryCodes } from '@/db';
import { extractUserIdFromToken, verifyPasskeyReauthToken } from '@/api/auth/jwt';
import { verifyPassword } from '@/lib/password';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import {
  verifyTotp,
  decryptSecret,
  verifyRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/mfa';
import { verifyPasskeyAssertion } from '@/lib/passkeyVerify';

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function requireUser(request: NextRequest): Promise<{ userId: string } | NextResponse> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }
  const userId = await extractUserIdFromToken(authHeader.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }
  return { userId };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const res = await requireUser(request);
  if (res instanceof NextResponse) return res;
  const { userId } = res;
  if (!limiter.check(userId)) return rateLimitResponse(corsHeaders);

  const { id } = await params;

  let body: { nickname?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders }); }

  const trimmed = (body.nickname ?? '').trim();
  if (!trimmed || trimmed.length > 80) {
    return NextResponse.json({ error: 'nickname required (1-80 chars)' }, { status: 400, headers: corsHeaders });
  }

  const result = await db.update(userPasskeys)
    .set({ nickname: trimmed })
    .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)))
    .returning({ id: userPasskeys.id });
  if (result.length === 0) {
    return NextResponse.json({ error: 'Passkey not found' }, { status: 404, headers: corsHeaders });
  }

  return NextResponse.json({ success: true }, { headers: corsHeaders });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const res = await requireUser(request);
  if (res instanceof NextResponse) return res;
  const { userId } = res;
  if (!limiter.check(userId)) return rateLimitResponse(corsHeaders);

  const { id } = await params;

  let body: {
    password?: string;
    code?: string;
    recoveryCode?: string;
    passkeyAssertion?: {
      reauthToken: string;
      response: AuthenticationResponseJSON;
    };
  };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders }); }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }

  const [target] = await db.select().from(userPasskeys)
    .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: 'Passkey not found' }, { status: 404, headers: corsHeaders });
  }

  const [otherPasskeys] = await db.select({ c: count() }).from(userPasskeys)
    .where(and(eq(userPasskeys.userId, userId), ne(userPasskeys.id, id), isNull(userPasskeys.disabledAt)));
  const [totpRows] = await db.select({ c: count() }).from(userMfa).where(eq(userMfa.userId, userId));
  const remaining = (otherPasskeys?.c ?? 0) + (totpRows?.c ?? 0);
  if (remaining === 0) {
    return NextResponse.json({ error: 'LAST_MFA_METHOD' }, { status: 409, headers: corsHeaders });
  }

  if (user.passwordHash) {
    if (!body.password) {
      return NextResponse.json({ error: 'password required' }, { status: 400, headers: corsHeaders });
    }
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json({ error: 'INVALID_REAUTH' }, { status: 401, headers: corsHeaders });
    }
  }

  const usingPasskey = !!body.passkeyAssertion;
  const usingRecovery = !!body.recoveryCode;
  const usingTotp = !!body.code;
  if (!usingPasskey && !usingRecovery && !usingTotp) {
    return NextResponse.json(
      { error: 'code, recoveryCode, or passkeyAssertion required' },
      { status: 400, headers: corsHeaders },
    );
  }

  let secondFactorOk = false;

  if (usingPasskey) {
    const claims = await verifyPasskeyReauthToken(body.passkeyAssertion!.reauthToken);
    if (!claims || claims.userId !== userId) {
      return NextResponse.json({ error: 'AUTH_CHALLENGE_EXPIRED' }, { status: 401, headers: corsHeaders });
    }
    const result = await verifyPasskeyAssertion({
      userId,
      expectedChallenge: claims.challenge,
      response: body.passkeyAssertion!.response,
    });
    if (result.kind === 'ok') {
      secondFactorOk = true;
    } else if (result.kind === 'clone') {
      return NextResponse.json({ error: 'CREDENTIAL_CLONE_DETECTED' }, { status: 401, headers: corsHeaders });
    }
  } else if (usingRecovery) {
    const normalized = normalizeRecoveryCode(body.recoveryCode!);
    const unused = await db.select().from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    for (const row of unused) {
      if (await verifyRecoveryCode(normalized, row.codeHash)) {
        const consumed = await db.update(userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(and(eq(userRecoveryCodes.id, row.id), isNull(userRecoveryCodes.usedAt)))
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
        ciphertext: mfaRow.secretEncrypted, iv: mfaRow.secretIv, authTag: mfaRow.secretAuthTag,
      });
      if (verifyTotp(secret, body.code!)) secondFactorOk = true;
    }
  }

  if (!secondFactorOk) {
    return NextResponse.json({ error: 'INVALID_REAUTH' }, { status: 401, headers: corsHeaders });
  }

  await db.delete(userPasskeys)
    .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)));

  return NextResponse.json({ success: true }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
