import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import { signWidgetUserJwt } from './WidgetService';

describe('signWidgetUserJwt', () => {
  const apiSecretHash = 'test-secret-32-chars-XXXXXXXXXXXX';
  const apiKey = 'fingerprint-32-chars-XXXXXXXXXXXX';

  function verifyAndDecode(token: string) {
    const key = new TextEncoder().encode(apiSecretHash);
    return jose.jwtVerify(token, key, { algorithms: ['HS256'] });
  }

  it('signs a widget_user JWT with sub=userId and fp=apiKey', async () => {
    const token = await signWidgetUserJwt({ apiSecretHash, apiKey, userId: 'user-123' });
    const { payload } = await verifyAndDecode(token);
    expect(payload.type).toBe('widget_user');
    expect(payload.sub).toBe('user-123');
    expect(payload.fp).toBe(apiKey);
  });

  it('includes userName when provided', async () => {
    const token = await signWidgetUserJwt({
      apiSecretHash, apiKey, userId: 'user-1', userName: 'Alice',
    });
    const { payload } = await verifyAndDecode(token);
    expect(payload.name).toBe('Alice');
  });

  it('omits name when userName not provided', async () => {
    const token = await signWidgetUserJwt({ apiSecretHash, apiKey, userId: 'user-1' });
    const { payload } = await verifyAndDecode(token);
    expect(payload.name).toBeUndefined();
  });

  it('expires 24h after issuance', async () => {
    const token = await signWidgetUserJwt({ apiSecretHash, apiKey, userId: 'user-1' });
    const { payload } = await verifyAndDecode(token);
    const ttl = (payload.exp ?? 0) - (payload.iat ?? 0);
    expect(ttl).toBe(24 * 60 * 60);
  });

  it('signed with the project apiSecretHash — other keys do not verify', async () => {
    const token = await signWidgetUserJwt({ apiSecretHash, apiKey, userId: 'user-1' });
    const wrongKey = new TextEncoder().encode('wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxx');
    await expect(jose.jwtVerify(token, wrongKey, { algorithms: ['HS256'] })).rejects.toThrow();
  });

  it('embeds the role claim under the given claim name', async () => {
    const token = await signWidgetUserJwt({
      apiSecretHash, apiKey, userId: 'user-1',
      roleClaim: { name: 'runhq_roles', roles: ['triager'] },
    });
    const { payload } = await verifyAndDecode(token);
    expect(payload.runhq_roles).toEqual(['triager']);
  });

  it('omits the role claim by default', async () => {
    const token = await signWidgetUserJwt({ apiSecretHash, apiKey, userId: 'user-1' });
    const { payload } = await verifyAndDecode(token);
    expect(payload.runhq_roles).toBeUndefined();
  });

  it('a role claim name colliding with a reserved claim cannot clobber it', async () => {
    const token = await signWidgetUserJwt({
      apiSecretHash, apiKey, userId: 'user-1', userName: 'Alice',
      roleClaim: { name: 'sub', roles: ['triager'] },
    });
    const { payload } = await verifyAndDecode(token);
    expect(payload.sub).toBe('user-1'); // reserved claim wins
  });
});
