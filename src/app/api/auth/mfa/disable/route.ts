import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db, users, userMfa, userRecoveryCodes, userPasskeys } from '@/db';
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

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

class InvalidMfaCodeError extends Error {}

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

  const usingPasskey = !!body.passkeyAssertion;
  const usingRecovery = !!body.recoveryCode;
  const usingTotp = !!body.code;
  if (!usingPasskey && !usingRecovery && !usingTotp) {
    return NextResponse.json(
      { error: 'code, recoveryCode, or passkeyAssertion required' },
      { status: 400, headers: corsHeaders },
    );
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  if (!user.mfaEnabled) return NextResponse.json({ error: 'MFA_NOT_ENABLED' }, { status: 409, headers: corsHeaders });

  // Password required only for accounts with a password.
  if (user.passwordHash) {
    if (!body.password) return NextResponse.json({ error: 'password required' }, { status: 400, headers: corsHeaders });
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json({ error: 'INVALID_PASSWORD' }, { status: 401, headers: corsHeaders });
    }
  }

  // Second-factor verification. The passkey and TOTP paths verify before the
  // teardown transaction (read-only or self-contained). The recovery path
  // verifies + consumes inside the teardown transaction so the consume +
  // teardown are atomic.
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
    // kind === 'invalid' falls through to the !secondFactorOk check below.
  } else if (usingTotp) {
    const [mfaRow] = await db.select().from(userMfa)
      .where(eq(userMfa.userId, userId)).limit(1);
    if (mfaRow) {
      const secret = decryptSecret({
        ciphertext: mfaRow.secretEncrypted,
        iv: mfaRow.secretIv,
        authTag: mfaRow.secretAuthTag,
      });
      secondFactorOk = verifyTotp(secret, body.code!);
    }
  }

  if (!usingRecovery && !secondFactorOk) {
    return NextResponse.json(
      { error: usingPasskey ? 'INVALID_PASSKEY' : 'INVALID_MFA_CODE' },
      { status: 401, headers: corsHeaders },
    );
  }

  // Consume (recovery) + teardown atomically.
  try {
    await db.transaction(async (tx) => {
      if (usingRecovery) {
        const normalized = normalizeRecoveryCode(body.recoveryCode!);
        const unused = await tx.select().from(userRecoveryCodes)
          .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
        let consumedOk = false;
        for (const row of unused) {
          if (await verifyRecoveryCode(normalized, row.codeHash)) {
            const consumed = await tx.update(userRecoveryCodes)
              .set({ usedAt: new Date() })
              .where(and(eq(userRecoveryCodes.id, row.id), isNull(userRecoveryCodes.usedAt)))
              .returning({ id: userRecoveryCodes.id });
            if (consumed.length > 0) consumedOk = true;
            break;
          }
        }
        if (!consumedOk) throw new InvalidMfaCodeError();
      }
      // Tear down MFA fully (happens in same tx; if this fails, the recovery-code consume rolls back).
      await tx.delete(userMfa).where(eq(userMfa.userId, userId));
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
      await tx.delete(userPasskeys).where(eq(userPasskeys.userId, userId));
      await tx.update(users)
        .set({ mfaEnabled: false, mfaEnabledAt: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
    });
  } catch (e) {
    if (e instanceof InvalidMfaCodeError) {
      return NextResponse.json({ error: 'INVALID_MFA_CODE' }, { status: 401, headers: corsHeaders });
    }
    throw e;
  }

  return NextResponse.json({ success: true }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
