import { extractUserIdFromToken } from '../auth/jwt';
import { verifyServerSessionToken } from '../services/ServerSessionService';

/**
 * Resolve the acting RunHQ user from a Bearer token forwarded to the internal
 * GitHub broker (`/api/internal/servers/:serverId/github/*`).
 *
 * The broker is reached two ways, and the Bearer differs by route:
 *
 *  1. **Via a workspace server** (the product path). The browser holds a
 *     workspace **server-session token** (EdDSA, scope `server:connect`,
 *     carrying `userId`+`serverId`) and the workspace forwards it verbatim when
 *     the user clicks "Install / configure GitHub". This token is signed with
 *     the BE's Ed25519 private key, so a workspace root user cannot forge one.
 *  2. **Directly** with a user **session JWT** (HS256) or **OAuth access token**
 *     — used by tests and any future first-party client that calls the BE
 *     without a workspace in between.
 *
 * We try the server-session format first because it is the format the product
 * UI actually sends; falling back to the direct user-token resolver keeps the
 * direct path working. Both prove a specific user's identity cryptographically,
 * so neither reintroduces the SERVER_TOKEN-impersonation path that motivated
 * deriving identity from the Bearer in the first place. Per-server
 * authorization is still enforced by the caller's `canAccessServer` check.
 */
export async function resolveGithubActingUser(bearer: string | null): Promise<string | null> {
  if (!bearer) return null;
  const session = await verifyServerSessionToken(bearer);
  if (session?.userId) return session.userId;
  return extractUserIdFromToken(bearer);
}
