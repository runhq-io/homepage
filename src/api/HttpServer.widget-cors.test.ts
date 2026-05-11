import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  serverTokenFetch: vi.fn(),
}));

vi.mock('./services/WidgetService', () => ({
  isOriginAllowlisted: vi.fn(),
  authenticateWidget: vi.fn(),
  listPublicProjects: vi.fn(),
  WidgetError: class WidgetError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = 'WidgetError';
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock('./services/WidgetRateLimiter', () => ({
  widgetRateLimiter: {
    check: vi.fn(),
    checkDefault: vi.fn(),
  },
}));

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';

const ALLOWED_ORIGIN = 'https://acme.test';
const OTHER_ORIGIN = 'https://other.test';

function makeApp() {
  return createHttpApp();
}

describe('widget CORS envelope', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    (WidgetService.isOriginAllowlisted as any).mockImplementation(async (origin: string) => origin === ALLOWED_ORIGIN);
  });

  it('answers widget preflight from an allowlisted origin with credentialed CORS and CSRF header support', async () => {
    const app = makeApp();
    const res = await app.request('/api/widget/identity', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-RW-Project, X-RunHQ-CSRF',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-RunHQ-CSRF');
  });

  it('keeps unallowlisted widget preflight on the legacy non-credentialed CORS envelope', async () => {
    const app = makeApp();
    const res = await app.request('/api/widget/identity', {
      method: 'OPTIONS',
      headers: {
        Origin: OTHER_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-RW-Project, X-RunHQ-CSRF',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-RunHQ-CSRF');
  });

  it('uses the credentialed CORS envelope on actual widget responses for allowlisted origins', async () => {
    const app = makeApp();
    const res = await app.request('/api/widget/identity', {
      headers: { Origin: ALLOWED_ORIGIN, 'X-RW-Project': 'project-a' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: null, csrfToken: null });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('uses the legacy CORS envelope on actual widget responses for unallowlisted origins', async () => {
    const app = makeApp();
    const res = await app.request('/api/widget/identity', {
      headers: { Origin: OTHER_ORIGIN, 'X-RW-Project': 'project-a' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: null, csrfToken: null });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
