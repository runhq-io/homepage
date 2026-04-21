import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db, users, userMfa, userRecoveryCodes } from '@/db';
import { extractUserIdFromToken, verifyPasskeyReauthToken } from '@/api/auth/jwt';
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
import { verifyPasskeyAssertion } from '@/lib/passkeyVerify';

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

class InvalidMfaCodeError extends Error {}

export async function POST(request: NextRequest) {
  const maybe = await requireUser(request);
  if (maybe instanceof NextResponse) return maybe;
  const userId = maybe;
  if (!regenLimiter.check(userId)) return rateLimitResponse(corsHeaders);

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

  if (user.passwordHash) {
    if (!body.password) return NextResponse.json({ error: 'password required' }, { status: 400, headers: corsHeaders });
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json({ error: 'INVALID_PASSWORD' }, { status: 401, headers: corsHeaders });
    }
  }

  // Second-factor verification (passkey / TOTP verified here; recovery
  // verified+consumed inside the replace-codes transaction below).
  let secondFactorOk = false;

  if (usingPasskey) {
    const claims = await verifyPasskeyReauthToken(body.passkeyAssertion!.reauthToken);
    if (!claims || claims.userId !== userId || claims.action !== 'regenerate-codes') {
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

  const plainCodes = generateRecoveryCodes(10);
  const hashedCodes = await Promise.all(plainCodes.map(hashRecoveryCode));

  // Consume (if recovery path) + replace codes atomically.
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
      // Replace all codes.
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
      await tx.insert(userRecoveryCodes).values(
        hashedCodes.map((codeHash) => ({ userId, codeHash })),
      );
    });
  } catch (e) {
    if (e instanceof InvalidMfaCodeError) {
      return NextResponse.json({ error: 'INVALID_MFA_CODE' }, { status: 401, headers: corsHeaders });
    }
    throw e;
  }

  return NextResponse.json({ recoveryCodes: plainCodes }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
