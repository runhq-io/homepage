import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { generateAuthCode, isFirstPartyClient } from '@/lib/oauth';
import { verifyToken } from '@/api/auth/jwt';
import { getDb, oauthClients, authorizationCodes } from '@/db';

const app = new Hono();

/**
 * OAuth params shared by both transports. Names match RFC 6749.
 */
interface AuthorizeParams {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

/**
 * Pure validation + code minting. Returns either an error to surface OR the
 * built redirect URL. Both transports (GET cookie-flow, POST bearer-flow)
 * share this — the only difference is how `userId` was established and how
 * the result is delivered.
 */
async function mintAuthCode(
  params: AuthorizeParams,
  userId: string,
): Promise<
  | { ok: true; redirectUrl: string }
  | { ok: false; status: number; body: { error: string; error_description: string } }
> {
  const { client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method } =
    params;

  if (response_type !== 'code') {
    return { ok: false, status: 400, body: { error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' } };
  }
  if (!client_id) {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'Missing client_id' } };
  }
  if (!redirect_uri) {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'Missing redirect_uri' } };
  }
  if (!code_challenge) {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'Missing code_challenge' } };
  }
  if (code_challenge_method !== 'S256') {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'Only code_challenge_method=S256 is supported' } };
  }

  const db = getDb();
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, client_id))
    .limit(1);

  if (!client) {
    return { ok: false, status: 400, body: { error: 'invalid_client', error_description: 'Unknown client_id' } };
  }

  // The registered redirect URIs are the source of truth — even though the
  // client (app.runhq.io login page) does a basic scheme check before POSTing,
  // the BE re-validates against the OAuth client row to prevent any crafted
  // redirect from being honored.
  if (!client.redirectUris.includes(redirect_uri)) {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'redirect_uri does not match any registered URI' } };
  }

  if (!isFirstPartyClient(client_id)) {
    return { ok: false, status: 403, body: { error: 'access_denied', error_description: 'Third-party clients are not yet supported' } };
  }

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

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  return { ok: true, redirectUrl: redirectUrl.toString() };
}

/**
 * GET /authorize — classic browser cookie flow.
 *
 * Reads the OAuth params from the query string and authenticates the user
 * via the `auth_token` cookie. Unauthenticated → 302 to /login?returnTo=.
 * Authenticated + valid → 302 to the deep-link redirect URI with code.
 */
app.get('/authorize', async (c) => {
  const params: AuthorizeParams = c.req.query();

  // Param validation first so unauthenticated callers with bad params see
  // a precise 400 instead of being looped through login only to fail later.
  // (This mirrors the original behavior — the first GET-version validated
  //  before checking auth.)

  // Authenticate via cookie.
  const authToken = getCookie(c, 'auth_token');
  const userId = authToken ? await verifyToken(authToken) : null;

  if (!userId) {
    // Defer to /login. The original URL (full query string) is preserved as
    // `returnTo` so the login form can navigate back to /authorize once the
    // session cookie is set.
    const returnTo = encodeURIComponent(c.req.url);
    return c.redirect(`/login?returnTo=${returnTo}`);
  }

  const result = await mintAuthCode(params, userId);
  if (!result.ok) {
    return c.json(result.body, result.status as 400 | 403);
  }
  return c.redirect(result.redirectUrl);
});

/**
 * POST /authorize — bearer-token flow for the app.runhq.io login handoff.
 *
 * This is the path the mobile OAuth flow uses. The mobile app opens an
 * `ASWebAuthenticationSession` against `app.runhq.io/login?<oauth params>`;
 * once the user signs in there (existing flow, including MFA/Passkey/
 * Google), the LoginPage POSTs back here with the freshly-minted bearer
 * token in `Authorization` and the OAuth params in the JSON body. We mint
 * a one-time auth code (same DB row, same PKCE binding) and return its
 * deep-link URL as JSON. The LoginPage then navigates `window.location`
 * to that URL — iOS hands the deep link to the mobile app, which exchanges
 * the code for the access token via the existing /oauth/token endpoint.
 *
 * Why a separate transport rather than reusing the GET path: a JS client
 * (app.runhq.io) can't follow a 302 to a custom scheme like
 * `io.runhq.app://` via `fetch` and then trigger a navigation — the
 * browser only treats `window.location.href = …` as a navigation request.
 * Returning JSON with `redirectUrl` lets the page do that navigation
 * itself. And accepting Bearer alongside cookies means we don't need to
 * broaden cookie scope to .runhq.io or build a second login UI on
 * console.runhq.io just to set the cookie.
 */
app.post('/authorize', async (c) => {
  const authz = c.req.header('authorization') ?? '';
  const match = authz.match(/^Bearer\s+(.+)$/i);
  const bearer = match ? match[1].trim() : null;
  const userId = bearer ? await verifyToken(bearer) : null;

  if (!userId) {
    return c.json(
      { error: 'invalid_token', error_description: 'Missing or invalid bearer token' },
      401,
    );
  }

  let body: AuthorizeParams;
  try {
    body = (await c.req.json()) as AuthorizeParams;
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Invalid JSON body' },
      400,
    );
  }

  const result = await mintAuthCode(body, userId);
  if (!result.ok) {
    return c.json(result.body, result.status as 400 | 403);
  }
  return c.json({ redirectUrl: result.redirectUrl });
});

export default app;
