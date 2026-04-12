import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { hashToken } from '@/lib/oauth';
import { getDb, oauthTokens } from '@/db';

const app = new Hono();

app.post('/revoke', async (c) => {
  const body = await c.req.parseBody();
  const token = body['token'] as string | undefined;

  // Per RFC 7009, missing token is technically invalid but we still return 200
  if (!token) {
    return c.json({});
  }

  const db = getDb();
  const tokenHash = hashToken(token);

  const [existing] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, tokenHash))
    .limit(1);

  if (existing && existing.revokedAt === null) {
    await db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.id, existing.id));
  }

  // Always return 200 with empty JSON body per RFC 7009
  return c.json({});
});

export default app;
