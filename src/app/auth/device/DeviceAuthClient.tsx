'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

interface SessionUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

function DeviceAuthContent() {
  const searchParams = useSearchParams();
  const [code, setCode] = useState(searchParams.get('code') || '');
  const [authorizing, setAuthorizing] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState('');

  // Session state (fetched via API instead of useSession)
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  // Invite code state
  const [inviteCode, setInviteCode] = useState('');
  const [activating, setActivating] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [isActivated, setIsActivated] = useState(false);
  const [checkingActivation, setCheckingActivation] = useState(true);

  // Check if user is logged in (via cookie-based session)
  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => {
        if (!res.ok) {
          setUser(null);
          setSessionLoading(false);
          setCheckingActivation(false);
          return;
        }
        return res.json();
      })
      .then(data => {
        if (data?.user) {
          setUser(data.user);
          setSessionLoading(false);
          // Now check activation status
          fetch('/api/invite/status')
            .then(res => res.json())
            .then(statusData => {
              setIsActivated(statusData.isActivated);
              setCheckingActivation(false);
            })
            .catch(() => setCheckingActivation(false));
        }
      })
      .catch(() => {
        setSessionLoading(false);
        setCheckingActivation(false);
      });
  }, []);

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
        // Reload to refresh state
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
    if (!user) {
      // Redirect to login, come back after
      const returnUrl = `/auth/device${userCode ? `?code=${userCode}` : ''}`;
      window.location.href = `/login?callbackUrl=${encodeURIComponent(returnUrl)}`;
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

  if (sessionLoading || checkingActivation) {
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
          <p className="text-slate-400">You can now close this window and return to the RunHQ app.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="max-w-md w-full p-8 bg-slate-800 rounded-xl">
          <h1 className="text-2xl font-bold text-white mb-4 text-center">Sign in to RunHQ</h1>
          <p className="text-slate-400 mb-6 text-center">Sign in to authorize the RunHQ desktop app.</p>

          {code && (
            <div className="mb-6 p-4 bg-slate-700 rounded-lg text-center">
              <p className="text-sm text-slate-400 mb-1">Device Code</p>
              <p className="text-2xl font-mono text-white tracking-wider">{code}</p>
            </div>
          )}

          <a
            href={`/login?callbackUrl=${encodeURIComponent(`/auth/device${code ? `?code=${code}` : ''}`)}`}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
          >
            Sign in to continue
          </a>
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
            RunHQ is currently invite-only. Enter an invite code from an existing user to activate your account.
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

          <p className="mt-4 text-sm text-slate-500 text-center">Signed in as {user.email}</p>
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
          <h1 className="text-2xl font-bold text-white mb-4 text-center">Authorize RunHQ App</h1>
          <p className="text-slate-400 mb-6 text-center">
            Authorize the RunHQ desktop app to sign in as:
          </p>

          <div className="mb-6 p-4 bg-slate-700 rounded-lg text-center">
            <p className="text-lg text-white font-medium">{user.name}</p>
            <p className="text-sm text-slate-400">{user.email}</p>
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

          <a
            href="/api/logout"
            className="block w-full px-4 py-3 bg-slate-700 text-white font-medium rounded-lg hover:bg-slate-600 transition-colors text-center"
          >
            Use different account
          </a>
        </div>
      </div>
    );
  }

  // No code in URL - show manual code entry
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900">
      <div className="max-w-md w-full p-8 bg-slate-800 rounded-xl">
        <h1 className="text-2xl font-bold text-white mb-4 text-center">Authorize RunHQ App</h1>
        <p className="text-slate-400 mb-6 text-center">Enter the code shown in the RunHQ desktop app to sign in.</p>

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

        <p className="mt-4 text-sm text-slate-500 text-center">Signed in as {user.name}</p>
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
