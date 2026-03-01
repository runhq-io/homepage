'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Sidebar, type SidebarUser } from '@/components/Sidebar';

export function DashboardChrome({ children, user }: { children: React.ReactNode; user?: SidebarUser | null }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer after navigation (mobile UX).
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  return (
    <div className="relative z-10 flex h-[100dvh] bg-slate-900/90">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} user={user} />

      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm md:hidden"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-30 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md">
          <div className="h-14 px-4 flex items-center gap-3">
            <button
              type="button"
              className="p-2 -ml-2 text-slate-300 hover:text-white"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-6 w-6" />
            </button>
            <span className="text-sm font-semibold text-white">Fishtank</span>
          </div>
        </div>

        <main className="flex-1 overflow-auto">
          <div className="p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
