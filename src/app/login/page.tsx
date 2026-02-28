'use client';

// IMPORTANT (regression prevention):
// Auth.js / NextAuth v5 requires initiating OAuth sign-in via **POST**.
// Do NOT replace these POST <form> submits with <a href="/api/auth/signin/{provider}"> links
// (those are GET requests and will fail in v5).

	import { LoginFooter } from '@/components/LoginFooter';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

const LOGIN_DELAY_MS = 2000;

export default function LoginPage() {
  const [animating, setAnimating] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const navTimeoutRef = useRef<number | null>(null);


  useEffect(() => {
    // Fetch CSRF token on mount (required for POST /api/auth/signin/*).
    // NextAuth uses a double-submit cookie pattern, so we need both:
    //   1) a csrf cookie (set by GET /api/auth/csrf)
    //   2) the csrfToken hidden input in our POST form
    fetch('/api/auth/csrf')
      .then((res) => res.json())
      .then((data) => setCsrfToken(data.csrfToken ?? ''))
      .catch(() => {
        // If this fails (network/ad-block/etc.), buttons stay disabled and the classic
        // /api/auth/signin fallback link remains available.
      });

    return () => {
      if (navTimeoutRef.current) {
        window.clearTimeout(navTimeoutRef.current);
      }
    };
  }, []);


  const handleLoginSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Prevent double-submit
    if (animating) {
      e.preventDefault();
      return;
    }


    // Accessibility: users who prefer reduced motion should not be delayed.
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return; // allow normal submit


    e.preventDefault();

    // Firefox tends to keep a "focused/active" visual state on the submit button
    // during our 2s navigation delay. Explicitly blur the actual submitter.
    const nativeEvent = e.nativeEvent as SubmitEvent;
    const submitter = (nativeEvent?.submitter as HTMLElement | null) ?? null;
    submitter?.blur?.();
    (document.activeElement as HTMLElement | null)?.blur?.();

    setAnimating(true);

    const form = e.currentTarget;
    navTimeoutRef.current = window.setTimeout(() => {
      form.submit();
    }, LOGIN_DELAY_MS);
  };

  return (
    <div className={`min-h-screen overflow-x-hidden ${animating ? 'bw-login-animating' : ''}`}>
      {/* Subtle animated background glow (same style as homepage) */}
      <div className="bw-animated-bg" aria-hidden="true" />

      {/* Light-speed overlay (CSS-only animation; JS only delays navigation) */}
      <div className="bw-login-lightspeed" aria-hidden="true" />


	      <div className="relative z-10 min-h-screen flex flex-col">
	        <main className="flex-1 flex items-center justify-center px-4 bw-login-interactive" aria-busy={animating}>
	          <div className="max-w-md w-full space-y-6 sm:space-y-8 p-6 sm:p-8 bg-slate-800/90 rounded-xl shadow-2xl border border-slate-700 bw-login-card">
            <div className="text-center">
              <h1 className="text-3xl font-bold text-white">Fishtank</h1>
              <p className="mt-2 text-slate-400">Sign in to access the dashboard</p>
            </div>

	            <div className="space-y-4">
              {/*
	                Auth.js v5 requires OAuth initiation via POST.
	                We use HTML forms to POST to /api/auth/signin/* (with CSRF token).

	                Progressive enhancement / no-JS fallback:
	                If JavaScript is disabled, we send users to NextAuth's built-in sign-in page
	                (/api/auth/signin), which renders the correct POST forms + CSRF token server-side.
              */}

	              <noscript>
	                <style>{`.bw-login-js-only{display:none !important;}`}</style>
	                <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
	                  <p className="text-sm text-slate-300">
	                    JavaScript is required for the animated sign-in buttons. Use the classic sign-in page instead.
	                  </p>
                  <Link
                    href="/api/auth/signin?callbackUrl=%2F"
                    prefetch={false}
                    className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-white px-4 py-3 font-medium text-gray-800 hover:bg-gray-100"
                  >
	                    Continue to sign-in
                  </Link>
	                </div>
	              </noscript>

	              <div className="space-y-4 bw-login-js-only">
	                <form action="/api/auth/signin/google" method="POST" onSubmit={handleLoginSubmit}>
	                  <input type="hidden" name="csrfToken" value={csrfToken} />
	                  <input type="hidden" name="callbackUrl" value="/" />
	                  <button
	                    type="submit"
	                    disabled={animating || !csrfToken}
		                    className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 rounded-lg font-medium cursor-pointer select-none hover:bg-gray-100 active:bg-gray-200 active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-fishtank-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
	                  >
					<svg className="w-5 h-5" viewBox="0 0 24 24">
						<path
							fill="currentColor"
							d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
						/>
						<path
							fill="#34A853"
							d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
						/>
						<path
							fill="#FBBC05"
							d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
						/>
						<path
							fill="#EA4335"
							d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
						/>
					</svg>
	                    Continue with Google
	                  </button>
	                </form>

	                <form action="/api/auth/signin/github" method="POST" onSubmit={handleLoginSubmit}>
	                  <input type="hidden" name="csrfToken" value={csrfToken} />
	                  <input type="hidden" name="callbackUrl" value="/" />
	                  <button
	                    type="submit"
	                    disabled={animating || !csrfToken}
		                    className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-slate-700 text-white rounded-lg font-medium cursor-pointer select-none hover:bg-slate-600 active:bg-slate-500 active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-fishtank-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
	                  >
					<svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
						<path
							fillRule="evenodd"
							clipRule="evenodd"
							d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
						/>
					</svg>
	                    Continue with GitHub
	                  </button>
	                </form>
	              </div>
	            </div>
          </div>
        </main>

        <LoginFooter />
      </div>
    </div>
  );
}

