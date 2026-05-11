import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

type FetchCall = {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    credentials?: string;
  };
};

function loadWidget(fetchImpl: (url: string, init: FetchCall['init']) => Promise<unknown>) {
  const source = readFileSync(join(process.cwd(), 'public', 'widget.js'), 'utf8');
  const script = {
    src: 'https://cdn.runhq.test/widget.js',
    getAttribute: vi.fn(() => 'https://cdn.runhq.test/widget.js'),
  };
  const windowMock: any = {
    location: { origin: 'https://customer.test' },
    onerror: null,
    addEventListener: vi.fn(),
  };
  const context = {
    window: windowMock,
    document: {
      querySelectorAll: vi.fn(() => [script]),
    },
    console: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    fetch: fetchImpl,
    Date,
    Error,
    JSON,
    Promise,
    String,
    TypeError,
    URL,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(source, context);
  return windowMock.RunHQWidget as { init(opts: Record<string, unknown>): void };
}

function pendingFetch(calls: FetchCall[]) {
  return (url: string, init: FetchCall['init']) => {
    calls.push({ url, init });
    return new Promise(() => {});
  };
}

async function waitForCallCount(calls: FetchCall[], count: number) {
  for (let i = 0; i < 20 && calls.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(calls.length).toBeGreaterThanOrEqual(count);
}

describe('public/widget.js cookie-auth fetch behavior', () => {
  it('sends credentials and X-RW-Project during cookie-auth bootstrap while preserving app-token fallback', () => {
    const calls: FetchCall[] = [];
    const widget = loadWidget(pendingFetch(calls));

    widget.init({ token: 'TOKEN_FROM_BACKEND', project: 'acme', useCookieAuth: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://cdn.runhq.test/api/widget/identity');
    expect(calls[0].init.credentials).toBe('include');
    expect(calls[0].init.headers?.Authorization).toBe('Bearer TOKEN_FROM_BACKEND');
    expect(calls[0].init.headers?.['X-RW-Project']).toBe('acme');
  });

  it('does not use credentialed CORS for token embeds unless useCookieAuth is explicitly enabled', () => {
    const calls: FetchCall[] = [];
    const widget = loadWidget(pendingFetch(calls));

    widget.init({ token: 'TOKEN_FROM_BACKEND', project: 'acme' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://cdn.runhq.test/api/widget/identity');
    expect(calls[0].init.credentials).toBeUndefined();
    expect(calls[0].init.headers?.Authorization).toBe('Bearer TOKEN_FROM_BACKEND');
    expect(calls[0].init.headers?.['X-RW-Project']).toBeUndefined();
  });

  it('falls back to non-credentialed requests after a cookie-auth identity CORS failure', async () => {
    const calls: FetchCall[] = [];
    const widget = loadWidget((url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return new Promise(() => {});
    });

    widget.init({ token: 'TOKEN_FROM_BACKEND', project: 'acme', useCookieAuth: true });
    await waitForCallCount(calls, 2);

    expect(calls[0].url).toBe('https://cdn.runhq.test/api/widget/identity');
    expect(calls[0].init.credentials).toBe('include');
    expect(calls[0].init.headers?.Authorization).toBe('Bearer TOKEN_FROM_BACKEND');
    expect(calls[0].init.headers?.['X-RW-Project']).toBe('acme');

    expect(calls[1].url).toBe('https://cdn.runhq.test/api/widget/tickets');
    expect(calls[1].init.credentials).toBeUndefined();
    expect(calls[1].init.headers?.Authorization).toBe('Bearer TOKEN_FROM_BACKEND');
  });

  it('falls back to public project reads after a project-only cookie-auth identity CORS failure', async () => {
    const calls: FetchCall[] = [];
    const widget = loadWidget((url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return new Promise(() => {});
    });

    widget.init({ project: 'acme', useCookieAuth: true });
    await waitForCallCount(calls, 2);

    expect(calls[0].url).toBe('https://cdn.runhq.test/api/widget/identity');
    expect(calls[0].init.credentials).toBe('include');
    expect(calls[0].init.headers?.Authorization).toBeUndefined();
    expect(calls[0].init.headers?.['X-RW-Project']).toBe('acme');

    expect(calls[1].url).toBe('https://cdn.runhq.test/api/widget/tickets');
    expect(calls[1].init.credentials).toBeUndefined();
    expect(calls[1].init.headers?.Authorization).toBeUndefined();
    expect(calls[1].init.headers?.['X-RW-Project']).toBe('acme');
  });
});
