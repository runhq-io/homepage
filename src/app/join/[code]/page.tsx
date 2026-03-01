'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Users, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface InviteInfo {
  serverName: string;
  creatorName: string;
  valid: boolean;
  expiresAt: string;
}

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Check auth status via API
  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => {
        setIsAuthenticated(res.ok);
        setAuthChecked(true);
      })
      .catch(() => {
        setIsAuthenticated(false);
        setAuthChecked(true);
      });
  }, []);

  // Fetch invite info (public, no auth required)
  useEffect(() => {
    if (!code) return;

    fetch(`/api/join/${code}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setInvite(data.invite);
        }
      })
      .catch(() => setError('Failed to load invite'))
      .finally(() => setLoading(false));
  }, [code]);

  // Auto-accept if user just logged in and came back to this page
  const pendingAccept = typeof window !== 'undefined' && sessionStorage.getItem('pendingInviteAccept') === code;

  useEffect(() => {
    if (pendingAccept && authChecked && isAuthenticated && invite?.valid && !accepting && !accepted) {
      sessionStorage.removeItem('pendingInviteAccept');
      handleAccept();
    }
  }, [pendingAccept, authChecked, isAuthenticated, invite]);

  const handleAccept = async () => {
    if (!isAuthenticated) {
      // Store intent and redirect to login
      sessionStorage.setItem('pendingInviteAccept', code);
      router.push(`/login?callbackUrl=${encodeURIComponent(`/join/${code}`)}`);
      return;
    }

    setAccepting(true);
    setError(null);

    try {
      const res = await fetch(`/api/join/${code}/accept`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to accept invite');
        setAccepting(false);
        return;
      }

      setAccepted(true);
      // Redirect to workspace after a brief moment
      setTimeout(() => {
        router.push('/');
      }, 1500);
    } catch {
      setError('Failed to accept invite');
      setAccepting(false);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="h-8 w-8 text-slate-400 animate-spin" />
      </div>
    );
  }

  // Error state
  if (error && !invite) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 mx-auto bg-red-500/10 rounded-2xl flex items-center justify-center mb-6">
            <XCircle className="h-8 w-8 text-red-400" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Invalid Invite Link</h1>
          <p className="text-slate-400">{error}</p>
        </div>
      </div>
    );
  }

  // Accepted state
  if (accepted) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 mx-auto bg-green-500/10 rounded-2xl flex items-center justify-center mb-6">
            <CheckCircle2 className="h-8 w-8 text-green-400" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">You're in!</h1>
          <p className="text-slate-400">Redirecting to your workspace...</p>
        </div>
      </div>
    );
  }

  // Invite page
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 mx-auto bg-slate-800 rounded-2xl flex items-center justify-center mb-6 border border-slate-700">
          <Users className="h-8 w-8 text-slate-400" />
        </div>

        <p className="text-slate-400 mb-1">You've been invited to join</p>
        <h1 className="text-2xl font-bold text-white mb-2">{invite?.serverName}</h1>
        <p className="text-slate-500 mb-8">Invited by {invite?.creatorName}</p>

        {error && (
          <p className="text-red-400 text-sm mb-4">{error}</p>
        )}

        {invite?.valid === false ? (
          <p className="text-slate-400">This invite link has expired or is no longer valid.</p>
        ) : (
          <button
            type="button"
            onClick={handleAccept}
            disabled={accepting}
            className="inline-flex items-center gap-2.5 px-8 py-3.5 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-lg"
          >
            {accepting ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-5 w-5" />
            )}
            {accepting ? 'Joining...' : 'Accept Invite'}
          </button>
        )}
      </div>
    </div>
  );
}
