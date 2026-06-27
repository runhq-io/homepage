import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { getDb, users, userMfa, userRecoveryCodes, userPasskeys } from '@/db';
import { hashPassword, verifyPassword } from '@/lib/password';
import { extractUserIdFromToken, verifyPasskeyReauthToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import {
  verifyTotp,
  decryptSecret,
  verifyRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/mfa';
import { verifyPasskeyAssertion } from '@/lib/passkeyVerify';

// Rate limiter: 10 attempts per 15 min per IP
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * POST /api/auth/change-password
 *
 * Changes the user's password. Requires Bearer token authentication.
 *
 * Authorization rules:
 *   - User has MFA or passkey enrolled → require a second factor (TOTP code,
 *     recovery code, or passkey assertion bound to action='change-password').
 *     A stolen session JWT alone is not sufficient to mint a permanent
 *     password login that survives session revocation.
 *   - User has a password but no MFA/passkey → currentPassword required
 *     (legacy login flow, matched against the existing hash).
 *   - User is OAuth-only with no MFA, no passkey, and no password → bearer
 *     JWT alone is accepted. This case has no out-of-band proof to require,
 *     and rejecting it would block the small OAuth-only population from
 *     adding a password without buying meaningful security (an attacker with
 *     a stolen session JWT can enroll MFA themselves and chain through).
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  if (!ipLimiter.check(ip)) {
    return rateLimitResponse(corsHeaders);
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }

  const token = authHeader.slice(7);
  const userId = await extractUserIdFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }

  let body: {
    currentPassword?: string;
    newPassword?: string;
    code?: string;
    recoveryCode?: string;
    passkeyAssertion?: {
      reauthToken: string;
      response: AuthenticationResponseJSON;
    };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const { currentPassword, newPassword } = body;

  if (!newPassword) {
    return NextResponse.json({ error: 'New password is required' }, { status: 400, headers: corsHeaders });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400, headers: corsHeaders });
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }

  const hasPassword = !!user.passwordHash;
  const hasMfa = !!user.mfaEnabled;
  const activePasskeys = await db
    .select({ id: userPasskeys.id })
    .from(userPasskeys)
    .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.disabledAt)))
    .limit(1);
  const hasPasskey = activePasskeys.length > 0;

  // Branch on user state. Each branch must complete a reauth check before
  // we proceed to write the new hash.
  if (hasMfa || hasPasskey) {
    // Strong reauth required.
    const usingPasskey = !!body.passkeyAssertion;
    const usingRecovery = !!body.recoveryCode;
    const usingTotp = !!body.code;
    if (!usingPasskey && !usingRecovery && !usingTotp) {
      return NextResponse.json(
        { error: 'REAUTH_REQUIRED', detail: 'code, recoveryCode, or passkeyAssertion required' },
        { status: 401, headers: corsHeaders },
      );
    }

    let secondFactorOk = false;

    if (usingPasskey) {
      const claims = await verifyPasskeyReauthToken(body.passkeyAssertion!.reauthToken);
      if (!claims || claims.userId !== userId || claims.action !== 'change-password') {
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
      const [mfaRow] = await db
        .select()
        .from(userMfa)
        .where(eq(userMfa.userId, userId))
        .limit(1);
      if (mfaRow) {
        const secret = decryptSecret({
          ciphertext: mfaRow.secretEncrypted,
          iv: mfaRow.secretIv,
          authTag: mfaRow.secretAuthTag,
        });
        secondFactorOk = verifyTotp(secret, body.code!);
      }
    } else if (usingRecovery) {
      const normalized = normalizeRecoveryCode(body.recoveryCode!);
      const unused = await db
        .select()
        .from(userRecoveryCodes)
        .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
      for (const row of unused) {
        if (await verifyRecoveryCode(normalized, row.codeHash)) {
          // Single-use: mark consumed before proceeding.
          const consumed = await db
            .update(userRecoveryCodes)
            .set({ usedAt: new Date() })
            .where(and(eq(userRecoveryCodes.id, row.id), isNull(userRecoveryCodes.usedAt)))
            .returning({ id: userRecoveryCodes.id });
          if (consumed.length > 0) secondFactorOk = true;
          break;
        }
      }
    }

    if (!secondFactorOk) {
      return NextResponse.json(
        { error: usingPasskey ? 'INVALID_PASSKEY' : usingRecovery ? 'INVALID_RECOVERY_CODE' : 'INVALID_MFA_CODE' },
        { status: 401, headers: corsHeaders },
      );
    }

    // For users with a current password we still cross-check it when supplied;
    // skip if absent — the second factor is the load-bearing check here.
    if (hasPassword && currentPassword) {
      const valid = await verifyPassword(currentPassword, user.passwordHash!);
      if (!valid) {
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401, headers: corsHeaders });
      }
    }
  } else if (hasPassword) {
    // Legacy: password-only account. Require currentPassword.
    if (!currentPassword) {
      return NextResponse.json({ error: 'Current password is required' }, { status: 400, headers: corsHeaders });
    }
    const valid = await verifyPassword(currentPassword, user.passwordHash!);
    if (!valid) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401, headers: corsHeaders });
    }
  }
  // else: OAuth-only with no MFA/passkey/password — bearer JWT alone is
  // sufficient. Adding a hard-block here doesn't meaningfully raise the bar
  // (an attacker with the JWT can enroll MFA themselves) and would block
  // legitimate OAuth users from setting their first password.

  const newHash = await hashPassword(newPassword);

  await db.update(users).set({
    passwordHash: newHash,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  return NextResponse.json({ message: 'Password updated successfully' }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
