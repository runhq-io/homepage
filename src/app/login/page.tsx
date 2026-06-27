'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * console.runhq.io/login — the real sign-in form.
 *
 * Owns three responsibilities the existing API already half-supported:
 *
 *  1. **Email + password.** POSTs same-origin to /api/auth/login *without*
 *     `returnToken`, so the API takes its cookie-setting branch and writes
 *     `auth_token` HttpOnly on console.runhq.io. Same-origin is what makes
 *     SameSite=Lax just work — no cross-origin Set-Cookie gymnastics.
 *
 *  2. **MFA (TOTP + recovery code).** If /api/auth/login returns
 *     `{ mfaRequired, mfaToken, mfaMethods }`, advance to step 2 and POST
 *     to /api/auth/mfa/verify, which also sets `auth_token` on success.
 *     Passkey is deferred — TOTP + recovery covers every MFA user
 *     functionally and keeps this page self-contained (the WebAuthn dance
 *     can come in a follow-up if anyone enables Passkey-only).
 *
 *  3. **OAuth handoff via ?returnTo=.** When /oauth/authorize bounces an
 *     unauthenticated browser here, it includes the full original URL as
 *     `returnTo`. After successful auth, we redirect there so the OAuth
 *     flow resumes with the freshly-set cookie. `returnTo` is validated
 *     to same-origin (or relative) to prevent open-redirect.
 *
 * Mobile/OAuth motivation: the prior stub said "go to app.runhq.io" with
 * no form, so /oauth/authorize → /login → dead end. The mobile dev build
 * couldn't complete sign-in at all. This page closes that gap without
 * touching app.runhq.io's auth flow or broadening cookie scope to
 * `.runhq.io`.
 */
function LoginContent() {
  const searchParams = useSearchParams();
  const rawReturnTo = searchParams.get('returnTo');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // MFA second step
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  /**
   * `returnTo` from the URL is attacker-controllable (the user can arrive
   * with any value), so it must be validated before we navigate there
   * post-login. Accept:
   *   - same-origin absolute URLs (what /oauth/authorize hands us)
   *   - relative paths that start with `/` but not `//` (which the URL
   *     parser would treat as protocol-relative → cross-origin)
   * Anything else falls back to `/`.
   */
  function safeReturnTo(): string {
    if (!rawReturnTo) return '/';
    try {
      const resolved = new URL(rawReturnTo, window.location.origin);
      if (resolved.origin !== window.location.origin) return '/';
      return resolved.pathname + resolved.search + resolved.hash;
    } catch {
      return '/';
    }
  }

  const handleCredentialsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No `returnToken: true` — we want the API's cookie branch so
        // the browser stores auth_token on console.runhq.io for the
        // subsequent /oauth/authorize navigation to pick up.
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        // /api/auth/login surfaces specific failure messages (unverified
        // email, Google-only account, etc.). Surface them verbatim — they're
        // user-actionable and not security-sensitive.
        setError(data.error || 'Sign-in failed');
        return;
      }

      if (data.mfaRequired) {
        setMfaToken(data.mfaToken);
        setMfaCode('');
        return;
      }

      // Cookie is set. Send the user back where they were headed.
      window.location.href = safeReturnTo();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfaToken) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mfaToken,
          code: mfaCode,
          isRecoveryCode: useRecoveryCode,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(
          data.error === 'INVALID_MFA_CODE'
            ? 'Invalid code'
            : data.error === 'MFA_TOKEN_EXPIRED'
              ? 'Session expired — please sign in again'
              : data.error || 'MFA verification failed',
        );
        // If the pending token expired, drop back to step 1 so the user
        // can re-enter their password rather than being stuck.
        if (data.error === 'MFA_TOKEN_EXPIRED') {
          setMfaToken(null);
          setPassword('');
        }
        return;
      }

      window.location.href = safeReturnTo();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
      <div className="max-w-md w-full p-6 sm:p-8 bg-slate-800/90 rounded-xl shadow-2xl border border-slate-700">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-white">RunHQ</h1>
          <p className="mt-2 text-slate-400">
            {mfaToken ? 'Two-factor authentication' : 'Sign in to continue'}
          </p>
        </div>

        {!mfaToken ? (
          <form onSubmit={handleCredentialsSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-600/20 text-red-400 rounded-lg text-sm text-center">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>

            <div className="mt-4 text-center text-sm text-slate-400">
              Don&rsquo;t have an account?{' '}
              <a href="https://app.runhq.io/signup" className="text-blue-400 hover:text-blue-300">
                Sign up on app.runhq.io
              </a>
            </div>
          </form>
        ) : (
          <form onSubmit={handleMfaSubmit} className="space-y-4">
            <div>
              <label htmlFor="mfa-code" className="block text-sm font-medium text-slate-300 mb-1">
                {useRecoveryCode ? 'Recovery code' : 'Authenticator code'}
              </label>
              <input
                id="mfa-code"
                type="text"
                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                pattern={useRecoveryCode ? undefined : '[0-9]*'}
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                required
                className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent tracking-widest text-center text-lg"
                placeholder={useRecoveryCode ? 'xxxx-xxxx-xxxx' : '000000'}
                autoFocus
              />
            </div>

            {error && (
              <div className="p-3 bg-red-600/20 text-red-400 rounded-lg text-sm text-center">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Verifying…' : 'Verify'}
            </button>

            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={() => {
                  setUseRecoveryCode((v) => !v);
                  setMfaCode('');
                  setError('');
                }}
                className="text-blue-400 hover:text-blue-300"
              >
                {useRecoveryCode ? 'Use authenticator app' : 'Use recovery code'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMfaToken(null);
                  setMfaCode('');
                  setError('');
                }}
                className="text-slate-400 hover:text-white"
              >
                Back
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-900">
          <div className="text-white">Loading…</div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
