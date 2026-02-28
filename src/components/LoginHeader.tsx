'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const MARKETING_ORIGIN = 'https://fishtank.bot';

const navLinks = [
  { href: `${MARKETING_ORIGIN}/`, label: 'Home' },
  { href: `${MARKETING_ORIGIN}/downloads`, label: 'Downloads' },
  { href: `${MARKETING_ORIGIN}/pricing`, label: 'Pricing' },
  { href: `${MARKETING_ORIGIN}/about`, label: 'About' },
];

export function LoginHeader() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Optional: mimic marketing header behavior by switching CTA label when a session exists.
  // (On the console domain this is a same-origin request, so no CORS complexity.)
  useEffect(() => {
    let cancelled = false;

    async function checkLogin() {
      try {
        const res = await fetch('/api/me', { method: 'GET', cache: 'no-store' });
        if (!cancelled) setIsLoggedIn(res.ok);
      } catch {
        if (!cancelled) setIsLoggedIn(false);
      }
    }

    checkLogin();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-800">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <a href={MARKETING_ORIGIN} className="flex items-center gap-2">
            <span className="text-xl font-bold text-white">Fishtank</span>
          </a>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-slate-300 hover:text-white transition-colors text-sm font-medium"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Primary CTA (kept lightweight vs marketing; same styling) */}
          <div className="hidden md:flex items-center gap-4">
            <Link
              href="/"
              className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
              aria-label={isLoggedIn ? 'Console' : 'Waitlist'}
            >
              {isLoggedIn ? 'Console' : 'Waitlist'}
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            type="button"
            className="md:hidden p-2 text-slate-300 hover:text-white"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((v) => !v)}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-slate-800">
            <nav className="flex flex-col gap-4">
              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-slate-300 hover:text-white transition-colors text-sm font-medium"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {link.label}
                </a>
              ))}

              <a
                href={`${MARKETING_ORIGIN}/downloads`}
                className="inline-flex justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                Start now
              </a>

              <Link
                href="/"
                className="inline-flex justify-center px-4 py-2 text-sm font-medium text-slate-300 hover:text-white border border-slate-700 rounded-lg transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                {isLoggedIn ? 'Console' : 'Waitlist'}
              </Link>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
