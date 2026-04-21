/**
 * Shared helper to verify a WebAuthn authentication assertion against a stored
 * credential. Used by login-verify and by reauth-gated destructive operations.
 *
 * Wraps the select-verify-update flow in a single transaction with
 * SELECT FOR UPDATE so concurrent verifies serialize. Clone detection + counter
 * monotonicity are enforced inside the lock.
 *
 * Returns a tagged result so callers can branch on the verification outcome
 * without parsing errors.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { db, userPasskeys } from '@/db';
import { getRpConfig } from './passkeys';

export type PasskeyVerifyResult =
  | { kind: 'ok' }
  | { kind: 'invalid' }
  | { kind: 'clone' };

export async function verifyPasskeyAssertion(args: {
  userId: string;
  expectedChallenge: string;
  response: AuthenticationResponseJSON;
}): Promise<PasskeyVerifyResult> {
  const { userId, expectedChallenge, response } = args;
  const { rpID, expectedOrigin } = getRpConfig();

  return db.transaction(async (tx) => {
    const [passkeyRow] = await tx.select().from(userPasskeys)
      .where(and(
        eq(userPasskeys.credentialId, response.id),
        eq(userPasskeys.userId, userId),
        isNull(userPasskeys.disabledAt),
      ))
      .for('update')
      .limit(1);

    if (!passkeyRow) return { kind: 'invalid' as const };

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: passkeyRow.credentialId,
          publicKey: Buffer.from(passkeyRow.publicKey, 'base64url'),
          counter: passkeyRow.counter,
          transports: (passkeyRow.transports as AuthenticatorTransportFuture[]) || undefined,
        },
      });
    } catch {
      return { kind: 'invalid' as const };
    }

    if (!verification.verified) return { kind: 'invalid' as const };

    const newCounter = verification.authenticationInfo.newCounter;

    if (passkeyRow.counter > 0 && newCounter > 0 && newCounter <= passkeyRow.counter) {
      await tx.update(userPasskeys)
        .set({ disabledAt: new Date() })
        .where(eq(userPasskeys.id, passkeyRow.id));
      return { kind: 'clone' as const };
    }

    await tx.update(userPasskeys)
      .set({
        counter: newCounter,
        lastUsedAt: new Date(),
        backedUp: verification.authenticationInfo.credentialBackedUp,
      })
      .where(eq(userPasskeys.id, passkeyRow.id));

    return { kind: 'ok' as const };
  });
}
