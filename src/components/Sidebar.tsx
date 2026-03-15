'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';

export interface SidebarUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  isAdmin: boolean;
}

export interface SidebarProps {
  /** Mobile-only: whether the sidebar drawer is open. On desktop it is always shown. */
  isOpen?: boolean;
  /** Mobile-only: invoked to close the drawer (e.g. close button / nav click). */
  onClose?: () => void;
  /** User data passed from server component */
  user?: SidebarUser | null;
}

export function Sidebar({ isOpen = false, onClose, user }: SidebarProps) {
  const pathname = usePathname();
  const isAdmin = user?.isAdmin;

  const mobileTranslateClass = isOpen ? 'translate-x-0' : '-translate-x-full';

  return (
    <div
      className={`fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col bg-slate-850 border-r border-slate-700 transform transition-transform duration-200 ease-out ${mobileTranslateClass} md:translate-x-0 md:relative md:z-0`}
      role="navigation"
      aria-label="Primary"
    >
      <div className="flex h-16 items-center justify-between px-6 border-b border-slate-700">
        <h1 className="text-xl font-bold text-white">RunHQ</h1>
        <button
          type="button"
          className="md:hidden p-2 -mr-2 text-slate-300 hover:text-white"
          aria-label="Close navigation"
          onClick={() => onClose?.()}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        <Link
          href="/"
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            pathname === '/' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'
          }`}
          onClick={() => onClose?.()}
        >
          <HomeIcon className="h-5 w-5" />
          Dashboard
        </Link>

        <Link
          href="/servers"
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            pathname === '/servers' || pathname.startsWith('/servers/')
              ? 'bg-blue-600 text-white'
              : 'text-slate-300 hover:bg-slate-700 hover:text-white'
          }`}
          onClick={() => onClose?.()}
        >
          <ServersIcon className="h-5 w-5" />
          Servers
        </Link>

        {isAdmin && (
          <Link
            href="/admin"
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              pathname.startsWith('/admin') ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'
            }`}
            onClick={() => onClose?.()}
          >
            <ShieldIcon className="h-5 w-5" />
            Admin
          </Link>
        )}
      </nav>

      <div className="border-t border-slate-700 p-4">
        <div className="flex items-center gap-3">
          {user?.image && (
            <img src={user.image} alt="" className="h-8 w-8 rounded-full" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{user?.name}</p>
            <p className="text-xs text-slate-400 truncate">{isAdmin ? 'Admin' : 'User'}</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="https://runhq.io/docs/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400 hover:text-white"
              title="Help"
              aria-label="Help"
              onClick={() => onClose?.()}
            >
              <HelpIcon className="h-5 w-5" />
            </a>

            <a href="/api/logout" className="text-slate-400 hover:text-white" title="Sign out">
              <LogoutIcon className="h-5 w-5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

function LogoutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  );
}

function HelpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8.228 9.247a3.75 3.75 0 117.5 0c0 2.25-3 2.25-3 4.5m.008 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function ServersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
      />
    </svg>
  );
}
