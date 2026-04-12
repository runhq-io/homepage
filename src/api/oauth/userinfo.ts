import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { hashToken } from '@/lib/oauth';
import { getDb, oauthTokens, users } from '@/db';

const app = new Hono();

app.get('/userinfo', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      { error: 'invalid_token', error_description: 'Missing or invalid Authorization header' },
      401
    );
  }

  const accessToken = authHeader.slice(7);
  const db = getDb();
  const tokenHash = hashToken(accessToken);

  const [tokenRecord] = await db
    .select()
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.tokenHash, tokenHash),
        eq(oauthTokens.type, 'access'),
        isNull(oauthTokens.revokedAt)
      )
    )
    .limit(1);

  if (!tokenRecord) {
    return c.json(
      { error: 'invalid_token', error_description: 'Token not found or revoked' },
      401
    );
  }

  if (tokenRecord.expiresAt <= new Date()) {
    return c.json(
      { error: 'invalid_token', error_description: 'Token has expired' },
      401
    );
  }

  const scopes = tokenRecord.scope.split(' ');
  if (!scopes.includes('profile')) {
    return c.json(
      { error: 'insufficient_scope', error_description: 'Token does not have profile scope' },
      403
    );
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, tokenRecord.userId))
    .limit(1);

  if (!user) {
    return c.json(
      { error: 'invalid_token', error_description: 'User not found' },
      401
    );
  }

  return c.json({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    avatar_url: user.avatarUrl,
  });
});

export default app;
