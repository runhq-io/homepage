import { NextRequest, NextResponse } from 'next/server';
import { count, eq } from 'drizzle-orm';
import { db, users, userMfa, userRecoveryCodes } from '@/db';
import {
  extractUserIdFromToken,
  verifyMfaSetupToken,
} from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import {
  verifyTotp,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/mfa';

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

class TotpAlreadyEnabledError extends Error {}

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

  let body: { setupToken?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }
  if (!body.setupToken || !body.code) {
    return NextResponse.json({ error: 'setupToken and code required' }, { status: 400, headers: corsHeaders });
  }

  const setupClaims = await verifyMfaSetupToken(body.setupToken);
  if (!setupClaims || setupClaims.userId !== userId) {
    return NextResponse.json({ error: 'SETUP_EXPIRED' }, { status: 401, headers: corsHeaders });
  }

  if (!verifyTotp(setupClaims.secret, body.code)) {
    return NextResponse.json({ error: 'INVALID_MFA_CODE' }, { status: 401, headers: corsHeaders });
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }

  const enc = encryptSecret(setupClaims.secret);

  // If the user has no recovery codes yet (e.g., first MFA method), provision a
  // fresh set. If they already have codes (from a prior passkey enrollment),
  // reuse those — we never want to silently rotate the user's existing codes
  // as a side-effect of adding a second factor.
  let newCodes: string[] | null = null;

  try {
    await db.transaction(async (tx) => {
      const [existingTotp] = await tx.select({ id: userMfa.id }).from(userMfa)
        .where(eq(userMfa.userId, userId)).limit(1);
      if (existingTotp) {
        throw new TotpAlreadyEnabledError();
      }

      await tx.insert(userMfa).values({
        userId,
        method: 'totp',
        secretEncrypted: enc.ciphertext,
        secretIv: enc.iv,
        secretAuthTag: enc.authTag,
      });

      const [{ c: existingCodes }] = await tx.select({ c: count() }).from(userRecoveryCodes)
        .where(eq(userRecoveryCodes.userId, userId));
      if (existingCodes === 0) {
        const plainCodes = generateRecoveryCodes(10);
        const hashedCodes = await Promise.all(plainCodes.map(hashRecoveryCode));
        await tx.insert(userRecoveryCodes).values(
          hashedCodes.map((codeHash) => ({ userId, codeHash })),
        );
        newCodes = plainCodes;
      }

      // mfaEnabled is idempotent — may already be true from a passkey enrollment.
      await tx.update(users)
        .set({ mfaEnabled: true, mfaEnabledAt: user.mfaEnabledAt ?? new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));
    });
  } catch (e) {
    if (e instanceof TotpAlreadyEnabledError) {
      return NextResponse.json({ error: 'TOTP_ALREADY_ENABLED' }, { status: 409, headers: corsHeaders });
    }
    throw e;
  }

  return NextResponse.json({ recoveryCodes: newCodes }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
