'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';

const navigation = [
  { name: 'Overview', href: '/admin', icon: HomeIcon },
  { name: 'Users', href: '/admin/users', icon: UsersIcon },
  { name: 'Agents', href: '/admin/agents', icon: CpuIcon },
  { name: 'Servers', href: '/admin/servers', icon: ServerIcon },
  { name: 'Templates', href: '/admin/templates', icon: TemplateIcon },
];

interface AdminSidebarProps {
  user: {
    name?: string | null;
    image?: string | null;
  };
  /** Mobile-only: whether the sidebar drawer is open. On desktop it is always shown. */
  isOpen?: boolean;
  /** Mobile-only: invoked to close the drawer (e.g. close button / nav click). */
  onClose?: () => void;
}

export function AdminSidebar({ user, isOpen = false, onClose }: AdminSidebarProps) {
  const pathname = usePathname();

  const mobileTranslateClass = isOpen ? 'translate-x-0' : '-translate-x-full';

  return (
    <div
      className={`fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col bg-slate-850 border-r border-slate-700 transform transition-transform duration-200 ease-out ${mobileTranslateClass} md:translate-x-0 md:relative md:z-0`}
      role="navigation"
      aria-label="Admin"
    >
      <div className="flex h-16 items-center justify-between px-6 border-b border-slate-700">
        <h1 className="text-xl font-bold text-white">Admin</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="text-sm text-slate-400 hover:text-white"
            onClick={() => onClose?.()}
          >
            &larr; Back
          </Link>
          <button
            type="button"
            className="md:hidden p-2 -mr-2 text-slate-300 hover:text-white"
            aria-label="Close navigation"
            onClick={() => onClose?.()}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {navigation.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/admin' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              onClick={() => onClose?.()}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-700 p-4">
        <div className="flex items-center gap-3">
          {user?.image && (
            <img src={user.image} alt="" className="h-8 w-8 rounded-full" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">
              {user?.name}
            </p>
            <p className="text-xs text-slate-400">Admin</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="https://fishtank.bot/docs/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400 hover:text-white"
              title="Help"
              aria-label="Help"
              onClick={() => onClose?.()}
            >
              <HelpIcon className="h-5 w-5" />
            </a>

            <Link
              href="/admin/settings"
              className="text-slate-400 hover:text-white"
              title="Settings"
              aria-label="Settings"
              onClick={() => onClose?.()}
            >
              <SettingsIcon className="h-5 w-5" />
            </Link>

            <a
              href="/api/logout"
              className="text-slate-400 hover:text-white"
              title="Sign out"
            >
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

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function CpuIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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

function ServerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
    </svg>
  );
}

function TemplateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  );
}
