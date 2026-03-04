'use client';

import { LoginFooter } from '@/components/LoginFooter';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [forgotSent, setForgotSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'forgot') {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        if (res.status === 429) {
          setError('Too many requests. Please try again later.');
          return;
        }

        setForgotSent(true);
        return;
      }

      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body: Record<string, string> = { email, password };
      if (mode === 'register') {
        body.username = username.trim().toLowerCase();
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Authentication failed');
        return;
      }

      // Cookie is set by the response — redirect to dashboard
      router.push('/');
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (newMode: 'login' | 'register' | 'forgot') => {
    setMode(newMode);
    setError('');
    setForgotSent(false);
  };

  return (
    <div className="min-h-screen overflow-x-hidden">
      {/* Subtle animated background glow (same style as homepage) */}
      <div className="bw-animated-bg" aria-hidden="true" />

      <div className="relative z-10 min-h-screen flex flex-col">
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="max-w-md w-full space-y-6 sm:space-y-8 p-6 sm:p-8 bg-slate-800/90 rounded-xl shadow-2xl border border-slate-700">
            <div className="text-center">
              <h1 className="text-3xl font-bold text-white">Fishtank</h1>
              <p className="mt-2 text-slate-400">
                {mode === 'login' && 'Sign in to access the dashboard'}
                {mode === 'register' && 'Create your account'}
                {mode === 'forgot' && 'Reset your password'}
              </p>
            </div>

            {mode === 'forgot' && forgotSent ? (
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto">
                  <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-slate-300">
                  If an account exists for <strong className="text-white">{email}</strong>, we've sent a password reset link.
                </p>
                <p className="text-sm text-slate-500">Check your email and follow the link to reset your password.</p>
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-4">
                  {mode === 'register' && (
                    <div>
                      <label htmlFor="username" className="block text-sm font-medium text-slate-300 mb-1">
                        Username
                      </label>
                      <input
                        id="username"
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                        required
                        minLength={3}
                        maxLength={20}
                        className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="Letters, numbers, underscores (3-20 chars)"
                        autoComplete="username"
                      />
                    </div>
                  )}

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
                      className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                  </div>

                  {mode !== 'forgot' && (
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
                        minLength={8}
                        className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      />
                    </div>
                  )}

                  {error && (
                    <div className="p-3 bg-red-600/20 text-red-400 rounded-lg text-sm text-center">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800"
                  >
                    {loading
                      ? (mode === 'login' ? 'Signing in...' : mode === 'register' ? 'Creating account...' : 'Sending...')
                      : (mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link')
                    }
                  </button>
                </form>

                <div className="text-center space-y-2">
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => switchMode('forgot')}
                      className="block w-full text-sm text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Forgot password?
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => switchMode(mode === 'register' ? 'login' : mode === 'forgot' ? 'login' : 'register')}
                    className="text-sm text-slate-400 hover:text-white transition-colors"
                  >
                    {mode === 'login' && "Don't have an account? Create one"}
                    {mode === 'register' && 'Already have an account? Sign in'}
                    {mode === 'forgot' && 'Back to sign in'}
                  </button>
                </div>
              </>
            )}
          </div>
        </main>

        <LoginFooter />
      </div>
    </div>
  );
}
