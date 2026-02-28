'use client';

import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Suspense, useEffect, useState } from 'react';
import { signIn, signOut } from 'next-auth/react';

function DeviceAuthContent() {
  const searchParams = useSearchParams();
  const { data: session, status, update: updateSession } = useSession();
  const [code, setCode] = useState(searchParams.get('code') || '');
  const [authorizing, setAuthorizing] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState('');

  // Invite code state
  const [inviteCode, setInviteCode] = useState('');
  const [activating, setActivating] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [isActivated, setIsActivated] = useState(false);
  const [checkingActivation, setCheckingActivation] = useState(true);

  // Check activation status from DB on mount (not from stale session)
  useEffect(() => {
    if (session?.user) {
      fetch('/api/invite/status')
        .then(res => res.json())
        .then(data => {
          setIsActivated(data.isActivated);
          setCheckingActivation(false);
        })
        .catch(() => setCheckingActivation(false));
    } else if (status !== 'loading') {
      setCheckingActivation(false);
    }
  }, [session?.user?.email, status]);

  // Handle prompt=select_account - sign out first to force account picker
  useEffect(() => {
    const promptParam = searchParams.get('prompt');
    const codeParam = searchParams.get('code');
    if (promptParam === 'select_account' && session?.user) {
      // Sign out and redirect back with code (without prompt param to prevent loop)
      signOut({ redirect: false }).then(() => {
        const callbackUrl = `/auth/device${codeParam ? `?code=${codeParam}` : ''}`;
        // Third argument passes authorization params to Google OAuth
        signIn('google', { callbackUrl }, { prompt: 'select_account' });
      });
    }
  }, [searchParams, session]);

  // Handle switching accounts
  const handleSwitchAccount = () => {
    signOut({ redirect: false }).then(() => {
      const callbackUrl = `/auth/device${code ? `?code=${code}` : ''}`;
      signIn('google', { callbackUrl }, { prompt: 'select_account' });
    });
  };

  const handleActivate = async () => {
    if (!inviteCode.trim()) {
      setInviteError('Please enter an invite code');
      return;
    }

    setActivating(true);
    setInviteError('');

    try {
      const res = await fetch('/api/invite/use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: inviteCode.trim() }),
      });

      const data = await res.json();
      if (res.ok || data.error === 'Account already activated') {
        // Refresh session to get updated isActivated status
        await updateSession();
        // Force a page reload to get fresh session data
        window.location.reload();
      } else {
        setInviteError(data.error || 'Invalid invite code');
      }
    } catch (err) {
      setInviteError('Failed to activate account');
    } finally {
      setActivating(false);
    }
  };

  const handleAuthorize = async (userCode: string) => {
    if (!session?.user) {
      signIn('google', { callbackUrl: `/auth/device?code=${userCode}` });
      return;
    }

    if (!isActivated) {
      return; // Don't authorize if not activated
    }

    setAuthorizing(true);
    setError('');

    try {
      const res = await fetch('/api/auth/device/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode }),
      });

      if (res.ok) {
        setAuthorized(true);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to authorize');
      }
    } catch (err) {
      setError('Failed to authorize device');
    } finally {
      setAuthorizing(false);
    }
  };

  if (status === 'loading' || checkingActivation) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  if (authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="max-w-md w-full p-8 bg-slate-800 rounded-xl text-center">
          <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Device Authorized</h1>
		          <p className="text-slate-400">You can now close this window and return to the Fishtank app.</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="max-w-md w-full p-8 bg-slate-800 rounded-xl">
          <h1 className="text-2xl font-bold text-white mb-4 text-center">Sign in to Tribe</h1>
          <p className="text-slate-400 mb-6 text-center">Sign in to authorize the Tribe desktop app.</p>

          {code && (
            <div className="mb-6 p-4 bg-slate-700 rounded-lg text-center">
              <p className="text-sm text-slate-400 mb-1">Device Code</p>
              <p className="text-2xl font-mono text-white tracking-wider">{code}</p>
            </div>
          )}

          <button
            onClick={() => signIn('google', { callbackUrl: `/auth/device${code ? `?code=${code}` : ''}` })}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 rounded-lg font-medium hover:bg-gray-100 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  // User is logged in but not activated - show invite code input
  if (!isActivated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="max-w-md w-full p-8 bg-slate-800 rounded-xl">
          <div className="w-16 h-16 bg-amber-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2 text-center">Enter Invite Code</h1>
          <p className="text-slate-400 mb-6 text-center">
            Tribe is currently invite-only. Enter an invite code from an existing user to activate your account.
          </p>

          <div className="mb-6">
            <label className="block text-sm text-slate-400 mb-2">Invite Code</label>
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.replace(/\s/g, ''))}
              placeholder="AbC12DeF"
              className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white text-center text-2xl font-mono tracking-wider placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
              maxLength={8}
            />
          </div>

          {inviteError && (
            <div className="mb-4 p-3 bg-red-600/20 text-red-400 rounded-lg text-center">
              {inviteError}
            </div>
          )}

          <button
            onClick={handleActivate}
            disabled={!inviteCode || activating}
            className="w-full px-4 py-3 bg-amber-600 text-white font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {activating ? 'Activating...' : 'Activate Account'}
          </button>

          <p className="mt-4 text-sm text-slate-500 text-center">Signed in as {session.user?.email}</p>
        </div>
      </div>
    );
  }

  // If code is in URL, show confirmation screen
  const codeFromUrl = searchParams.get('code');
  if (codeFromUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="max-w-md w-full p-8 bg-slate-800 rounded-xl">
          <h1 className="text-2xl font-bold text-white mb-4 text-center">Authorize Fishtank App</h1>
          <p className="text-slate-400 mb-6 text-center">
            Authorize the Fishtank desktop app to sign in as:
          </p>

          <div className="mb-6 p-4 bg-slate-700 rounded-lg text-center">
            <p className="text-lg text-white font-medium">{session.user?.name}</p>
            <p className="text-sm text-slate-400">{session.user?.email}</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-600/20 text-red-400 rounded-lg text-center">{error}</div>
          )}

          <button
            onClick={() => handleAuthorize(codeFromUrl)}
            disabled={authorizing}
            className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-3"
          >
            {authorizing ? 'Authorizing...' : 'Authorize'}
          </button>

          <button
            onClick={handleSwitchAccount}
            disabled={authorizing}
            className="w-full px-4 py-3 bg-slate-700 text-white font-medium rounded-lg hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Use different account
          </button>
        </div>
      </div>
    );
  }

  // No code in URL - show manual code entry
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900">
      <div className="max-w-md w-full p-8 bg-slate-800 rounded-xl">
        <h1 className="text-2xl font-bold text-white mb-4 text-center">Authorize Fishtank App</h1>
        <p className="text-slate-400 mb-6 text-center">Enter the code shown in the Fishtank desktop app to sign in.</p>

        <div className="mb-6">
          <label className="block text-sm text-slate-400 mb-2">Device Code</label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\s/g, '').toUpperCase())}
            placeholder="XXXXXXXX"
            className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white text-center text-2xl font-mono tracking-wider placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            maxLength={8}
          />
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-600/20 text-red-400 rounded-lg text-center">{error}</div>
        )}

        <button
          onClick={() => handleAuthorize(code)}
          disabled={!code || authorizing}
          className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {authorizing ? 'Authorizing...' : 'Authorize Device'}
        </button>

        <p className="mt-4 text-sm text-slate-500 text-center">Signed in as {session.user?.name}</p>
      </div>
    </div>
  );
}

export default function DeviceAuthClient() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-900">
          <div className="text-white">Loading...</div>
        </div>
      }
    >
      <DeviceAuthContent />
    </Suspense>
  );
}
