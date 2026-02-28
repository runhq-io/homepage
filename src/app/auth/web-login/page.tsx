'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn, signOut, useSession } from 'next-auth/react';

/**
 * Web Login Page
 *
 * Handles OAuth for the web client.
 * Flow:
 * 1. Web client redirects here with ?returnUrl=...&prompt=select_account
 * 2. If already logged in AND prompt=select_account, sign out first to force account picker
 * 3. If not logged in, trigger Google OAuth with prompt=select_account
 * 4. Once logged in (after OAuth callback), generate token and redirect back to web client
 */
function WebLoginContent() {
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get('returnUrl') || (process.env.NODE_ENV === 'production' ? 'https://app.fishtank.bot/login' : 'http://localhost:5180');
  const forceAccountPicker = searchParams.get('prompt') === 'select_account';
  const { data: session, status } = useSession();
  const [error, setError] = useState<string | null>(null);
  // Prevent double signIn calls from race between signOut().then() and useEffect re-fire
  const signingInRef = useRef(false);

  useEffect(() => {
    if (status === 'loading') return;

    // Already authenticated - check if we need to force account selection
    if (status === 'authenticated' && session?.user) {
      // If user wants to pick a different account, sign out and restart OAuth
      if (forceAccountPicker && !sessionStorage.getItem('webLoginOAuthStarted')) {
        sessionStorage.setItem('webLoginOAuthStarted', 'true');
        sessionStorage.setItem('webLoginReturnUrl', returnUrl);
        localStorage.setItem('webLoginReturnUrl', returnUrl);
        signingInRef.current = true;
        signOut({ redirect: false }).then(() => {
          signIn('google', { callbackUrl: '/auth/web-login' }, { prompt: 'select_account' });
        });
        return;
      }

      // Coming back from OAuth (no prompt param) - generate token and redirect
      sessionStorage.removeItem('webLoginOAuthStarted');
      const storedReturnUrl = sessionStorage.getItem('webLoginReturnUrl') || localStorage.getItem('webLoginReturnUrl') || returnUrl;
      sessionStorage.removeItem('webLoginReturnUrl');
      localStorage.removeItem('webLoginReturnUrl');
      generateTokenAndRedirect(storedReturnUrl);
      return;
    }

    // Not authenticated - trigger OAuth (but skip if already initiated by signOut flow above)
    if (status === 'unauthenticated' && !signingInRef.current) {
      sessionStorage.setItem('webLoginReturnUrl', returnUrl);
      localStorage.setItem('webLoginReturnUrl', returnUrl);
      signingInRef.current = true;
      signIn('google', { callbackUrl: '/auth/web-login' }, { prompt: 'select_account' });
      return;
    }
  }, [status, session, returnUrl, forceAccountPicker]);

  const generateTokenAndRedirect = async (targetUrl: string) => {
    try {
      // Call API to generate a web session token
      const res = await fetch('/api/auth/web-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to generate token');
      }

      const { token } = await res.json();

      // Redirect back to web client with token
      const url = new URL(targetUrl);
      url.searchParams.set('token', token);
      window.location.href = url.toString();
    } catch (err) {
      console.error('Failed to generate token:', err);
      setError(err instanceof Error ? err.message : 'Failed to complete login');
    }
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => window.location.href = returnUrl}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
          >
            Return to app
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-400">
          {status === 'loading' && 'Loading...'}
          {status === 'unauthenticated' && 'Redirecting to login...'}
          {status === 'authenticated' && 'Completing login...'}
        </p>
      </div>
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-400">Loading...</p>
      </div>
    </div>
  );
}

export default function WebLoginPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <WebLoginContent />
    </Suspense>
  );
}
