import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { generateAuthCode, isFirstPartyClient } from '@/lib/oauth';
import { verifyToken } from '@/api/auth/jwt';
import { getDb, oauthClients, authorizationCodes } from '@/db';

const app = new Hono();

app.get('/authorize', async (c) => {
  const { client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method } =
    c.req.query();

  // Validate response_type
  if (response_type !== 'code') {
    return c.json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' }, 400);
  }

  // Validate required params
  if (!client_id) {
    return c.json({ error: 'invalid_request', error_description: 'Missing client_id' }, 400);
  }
  if (!redirect_uri) {
    return c.json({ error: 'invalid_request', error_description: 'Missing redirect_uri' }, 400);
  }
  if (!code_challenge) {
    return c.json({ error: 'invalid_request', error_description: 'Missing code_challenge' }, 400);
  }
  if (code_challenge_method !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'Only code_challenge_method=S256 is supported' }, 400);
  }

  // Look up client
  const db = getDb();
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, client_id))
    .limit(1);

  if (!client) {
    return c.json({ error: 'invalid_client', error_description: 'Unknown client_id' }, 400);
  }

  // Validate redirect_uri exactly matches a registered URI
  if (!client.redirectUris.includes(redirect_uri)) {
    return c.json({ error: 'invalid_request', error_description: 'redirect_uri does not match any registered URI' }, 400);
  }

  // Check if user is logged in via auth_token cookie
  const authToken = getCookie(c, 'auth_token');
  const userId = authToken ? await verifyToken(authToken) : null;

  if (!userId) {
    // Redirect to login, preserving all query params as returnTo
    const returnTo = encodeURIComponent(c.req.url);
    return c.redirect(`/login?returnTo=${returnTo}`);
  }

  // Check first-party vs third-party
  if (!isFirstPartyClient(client_id)) {
    return c.json({ error: 'access_denied', error_description: 'Third-party clients are not yet supported' }, 403);
  }

  // Auto-approve for first-party clients — generate auth code
  const code = generateAuthCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.insert(authorizationCodes).values({
    code,
    clientId: client_id,
    userId,
    redirectUri: redirect_uri,
    scope: scope ?? '',
    codeChallenge: code_challenge,
    expiresAt,
  });

  // Build redirect URL
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  return c.redirect(redirectUrl.toString());
});

export default app;
