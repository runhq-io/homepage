"use client";

import Link from "next/link";

export function LoginFooter() {
  return (
    <footer className="border-t border-slate-800 bg-slate-900">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-white">Fishtank</span>
            <span className="text-slate-500 text-sm">End The Mundane</span>
          </div>

          <nav className="flex items-center gap-6">
            <Link href="https://fishtank.bot/" className="text-slate-400 hover:text-white text-sm transition-colors">
              Home
            </Link>
            <Link
              href="https://fishtank.bot/downloads"
              className="text-slate-400 hover:text-white text-sm transition-colors"
            >
              Downloads
            </Link>
            <Link
              href="https://fishtank.bot/pricing"
              className="text-slate-400 hover:text-white text-sm transition-colors"
            >
              Pricing
            </Link>
            <Link
              href="https://fishtank.bot/about"
              className="text-slate-400 hover:text-white text-sm transition-colors"
            >
              About
            </Link>
          </nav>

          <p className="text-slate-500 text-sm">
            &copy; {new Date().getFullYear()} Fishtank. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
