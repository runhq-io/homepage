/**
 * Integration tests for web authentication flow
 *
 * Tests:
 * 1. Token generation (/api/auth/web-token)
 * 2. Token validation (/api/auth/web-me)
 * 3. Edge cases: expired tokens, invalid tokens, missing userId
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the auth module before importing the route handlers
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

// Mock the db module
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
  users: { id: 'id', email: 'email', name: 'name', avatarUrl: 'avatar_url' },
}));

import { auth } from '@/lib/auth';
import { getDb, users } from '@/db';
import { POST as webTokenHandler } from './web-token/route';
import { GET as webMeHandler } from './web-me/route';

describe('Web Auth Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/auth/web-token', () => {
    it('should generate token with userId when authenticated', async () => {
      // Mock authenticated session
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        expires: new Date(Date.now() + 86400000).toISOString(),
      } as any);

      const response = await webTokenHandler();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.token).toBeDefined();

      // Decode and verify the token contains userId
      const decoded = JSON.parse(Buffer.from(body.token, 'base64').toString('utf-8'));
      expect(decoded.userId).toBe('user-123');
      expect(decoded.exp).toBeGreaterThan(Date.now());
    });

    it('should return 401 when not authenticated', async () => {
      vi.mocked(auth).mockResolvedValue(null as any);

      const response = await webTokenHandler();
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Not authenticated');
    });

    it('should return 401 when session has no user', async () => {
      vi.mocked(auth).mockResolvedValue({
        expires: new Date(Date.now() + 86400000).toISOString(),
      } as any);

      const response = await webTokenHandler();
      expect(response.status).toBe(401);
    });

    it('should return 500 when session.user.id is undefined', async () => {
      // This was the bug - session.user.id could be undefined
      // Now the endpoint validates and returns 500 instead of generating invalid token
      vi.mocked(auth).mockResolvedValue({
        user: { email: 'test@example.com', name: 'Test User' }, // Note: no id!
        expires: new Date(Date.now() + 86400000).toISOString(),
      } as any);

      const response = await webTokenHandler();
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Session missing user ID');
    });
  });

  describe('GET /api/auth/web-me', () => {
    const testUser = {
      id: 'user-456',
      email: 'webme@example.com',
      name: 'Web Me User',
      avatarUrl: 'https://example.com/avatar.png',
    };

    function createValidToken(userId: string, expOffset = 86400000) {
      return Buffer.from(
        JSON.stringify({
          userId,
          exp: Date.now() + expOffset,
        })
      ).toString('base64');
    }

    function createRequest(token?: string) {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      return new Request('http://localhost/api/auth/web-me', { headers });
    }

    it('should return user info for valid token', async () => {
      const token = createValidToken('user-456');

      // Mock database query
      vi.mocked(getDb).mockReturnValue({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([testUser]),
          }),
        }),
      } as any);

      const response = await webMeHandler(createRequest(token));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.user).toEqual({
        id: testUser.id,
        email: testUser.email,
        name: testUser.name,
        avatarUrl: testUser.avatarUrl,
      });
    });

    it('should return 401 when no token provided', async () => {
      const response = await webMeHandler(createRequest());
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('No token provided');
    });

    it('should return 401 for expired token', async () => {
      // Create token that expired 1 hour ago
      const token = createValidToken('user-456', -3600000);

      const response = await webMeHandler(createRequest(token));
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Token expired');
    });

    it('should return 401 for token without userId', async () => {
      // Create token without userId (the bug case)
      const token = Buffer.from(
        JSON.stringify({
          exp: Date.now() + 86400000,
          // Note: no userId!
        })
      ).toString('base64');

      const response = await webMeHandler(createRequest(token));
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Invalid token');
    });

    it('should return 401 for invalid base64 token', async () => {
      const response = await webMeHandler(createRequest('not-valid-base64!!!'));
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Invalid token');
    });

    it('should return 401 for token with non-existent user', async () => {
      const token = createValidToken('non-existent-user');

      // Mock database query returning no results
      vi.mocked(getDb).mockReturnValue({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      } as any);

      const response = await webMeHandler(createRequest(token));
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('User not found');
    });

    it('should include CORS headers in response', async () => {
      const token = createValidToken('user-456');

      vi.mocked(getDb).mockReturnValue({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([testUser]),
          }),
        }),
      } as any);

      const response = await webMeHandler(createRequest(token));

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    });
  });

  describe('End-to-end token flow', () => {
    it('should generate token that can be validated', async () => {
      const testUserId = 'e2e-user-789';
      const testUser = {
        id: testUserId,
        email: 'e2e@example.com',
        name: 'E2E User',
        avatarUrl: null,
      };

      // Step 1: Generate token
      vi.mocked(auth).mockResolvedValue({
        user: { id: testUserId, email: testUser.email, name: testUser.name },
        expires: new Date(Date.now() + 86400000).toISOString(),
      } as any);

      const tokenResponse = await webTokenHandler();
      expect(tokenResponse.status).toBe(200);
      const { token } = await tokenResponse.json();

      // Step 2: Validate token
      vi.mocked(getDb).mockReturnValue({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([testUser]),
          }),
        }),
      } as any);

      const meResponse = await webMeHandler(
        new Request('http://localhost/api/auth/web-me', {
          headers: { Authorization: `Bearer ${token}` },
        })
      );

      expect(meResponse.status).toBe(200);
      const { user } = await meResponse.json();
      expect(user.id).toBe(testUserId);
      expect(user.email).toBe(testUser.email);
    });
  });
});
