import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import {
  generateToken,
  hashToken,
  verifyPkce,
  verifyClientSecret,
} from '@/lib/oauth';
import { rateLimit } from '@/lib/rateLimit';
import { getDb, oauthClients, authorizationCodes, oauthTokens } from '@/db';

const app = new Hono();

// 20 requests per IP per 15 minutes
const tokenRateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

app.post('/token', async (c) => {
  // Rate limit by IP
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  if (!tokenRateLimiter.check(ip)) {
    return c.json(
      { error: 'invalid_request', error_description: 'Too many requests' },
      429
    );
  }

  const body = await c.req.parseBody();
  const grant_type = body['grant_type'] as string | undefined;

  if (!grant_type) {
    return c.json(
      { error: 'invalid_request', error_description: 'Missing grant_type' },
      400
    );
  }

  const db = getDb();

  // ── Authorization Code Grant ───────────────────────────────────────────────
  if (grant_type === 'authorization_code') {
    const code = body['code'] as string | undefined;
    const redirect_uri = body['redirect_uri'] as string | undefined;
    const client_id = body['client_id'] as string | undefined;
    const code_verifier = body['code_verifier'] as string | undefined;
    const client_secret = body['client_secret'] as string | undefined;

    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing required parameters: code, redirect_uri, client_id, code_verifier',
        },
        400
      );
    }

    // Look up client
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, client_id))
      .limit(1);

    if (!client) {
      return c.json(
        { error: 'invalid_client', error_description: 'Unknown client_id' },
        401
      );
    }

    // Confidential clients must provide client_secret
    if (client.isConfidential) {
      if (!client_secret) {
        return c.json(
          { error: 'invalid_client', error_description: 'client_secret required for confidential clients' },
          401
        );
      }
      const secretValid = await verifyClientSecret(client_secret, client.secretHash);
      if (!secretValid) {
        return c.json(
          { error: 'invalid_client', error_description: 'Invalid client_secret' },
          401
        );
      }
    }

    // Look up authorization code
    const [authCode] = await db
      .select()
      .from(authorizationCodes)
      .where(
        and(
          eq(authorizationCodes.code, code),
          eq(authorizationCodes.clientId, client_id)
        )
      )
      .limit(1);

    if (!authCode) {
      return c.json(
        { error: 'invalid_grant', error_description: 'Invalid authorization code' },
        400
      );
    }

    // Check not expired
    if (authCode.expiresAt <= new Date()) {
      return c.json(
        { error: 'invalid_grant', error_description: 'Authorization code has expired' },
        400
      );
    }

    // Check not already used
    if (authCode.usedAt !== null) {
      return c.json(
        { error: 'invalid_grant', error_description: 'Authorization code has already been used' },
        400
      );
    }

    // Validate redirect_uri
    if (authCode.redirectUri !== redirect_uri) {
      return c.json(
        { error: 'invalid_grant', error_description: 'redirect_uri does not match' },
        400
      );
    }

    // Validate PKCE
    if (!verifyPkce(code_verifier, authCode.codeChallenge)) {
      return c.json(
        { error: 'invalid_grant', error_description: 'PKCE verification failed' },
        400
      );
    }

    // Mark code as used
    await db
      .update(authorizationCodes)
      .set({ usedAt: new Date() })
      .where(eq(authorizationCodes.id, authCode.id));

    // Issue tokens
    const accessToken = generateToken();
    const refreshToken = generateToken();

    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
    const refreshExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.insert(oauthTokens).values([
      {
        tokenHash: hashToken(accessToken),
        type: 'access',
        clientId: client_id,
        userId: authCode.userId,
        scope: authCode.scope,
        expiresAt: accessExpiresAt,
      },
      {
        tokenHash: hashToken(refreshToken),
        type: 'refresh',
        clientId: client_id,
        userId: authCode.userId,
        scope: authCode.scope,
        expiresAt: refreshExpiresAt,
      },
    ]);

    return c.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: authCode.scope || 'profile',
    });
  }

  // ── Refresh Token Grant ────────────────────────────────────────────────────
  if (grant_type === 'refresh_token') {
    const refresh_token = body['refresh_token'] as string | undefined;
    const client_id = body['client_id'] as string | undefined;
    const client_secret = body['client_secret'] as string | undefined;

    if (!refresh_token || !client_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing required parameters: refresh_token, client_id',
        },
        400
      );
    }

    // Look up client
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, client_id))
      .limit(1);

    if (!client) {
      return c.json(
        { error: 'invalid_client', error_description: 'Unknown client_id' },
        401
      );
    }

    // Confidential clients must provide client_secret
    if (client.isConfidential) {
      if (!client_secret) {
        return c.json(
          { error: 'invalid_client', error_description: 'client_secret required for confidential clients' },
          401
        );
      }
      const secretValid = await verifyClientSecret(client_secret, client.secretHash);
      if (!secretValid) {
        return c.json(
          { error: 'invalid_client', error_description: 'Invalid client_secret' },
          401
        );
      }
    }

    // Look up refresh token by hash
    const tokenHash = hashToken(refresh_token);
    const [existingToken] = await db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, tokenHash),
          eq(oauthTokens.type, 'refresh'),
          eq(oauthTokens.clientId, client_id)
        )
      )
      .limit(1);

    if (!existingToken) {
      return c.json(
        { error: 'invalid_grant', error_description: 'Invalid refresh token' },
        400
      );
    }

    // Check not expired
    if (existingToken.expiresAt <= new Date()) {
      return c.json(
        { error: 'invalid_grant', error_description: 'Refresh token has expired' },
        400
      );
    }

    // Check not revoked
    if (existingToken.revokedAt !== null) {
      return c.json(
        { error: 'invalid_grant', error_description: 'Refresh token has been revoked' },
        400
      );
    }

    // Revoke old refresh token (rotation)
    await db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.id, existingToken.id));

    // Issue new token pair
    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();

    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
    const refreshExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.insert(oauthTokens).values([
      {
        tokenHash: hashToken(newAccessToken),
        type: 'access',
        clientId: client_id,
        userId: existingToken.userId,
        scope: existingToken.scope,
        expiresAt: accessExpiresAt,
      },
      {
        tokenHash: hashToken(newRefreshToken),
        type: 'refresh',
        clientId: client_id,
        userId: existingToken.userId,
        scope: existingToken.scope,
        expiresAt: refreshExpiresAt,
      },
    ]);

    return c.json({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: existingToken.scope || 'profile',
    });
  }

  // ── Unsupported grant type ─────────────────────────────────────────────────
  return c.json(
    {
      error: 'unsupported_grant_type',
      error_description: `Unsupported grant_type: ${grant_type}`,
    },
    400
  );
});

export default app;
