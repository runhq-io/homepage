'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AdminSidebar } from '@/components/AdminSidebar';

export function AdminChrome({
  user,
  children,
}: {
  user: { name?: string | null; image?: string | null };
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  return (
    <div className="relative z-10 flex h-[100dvh] bg-slate-900/90">
      <AdminSidebar user={user} isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm md:hidden"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
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
            <span className="text-sm font-semibold text-white">Admin</span>
          </div>
        </div>

        <main className="flex-1 overflow-auto">
          <div className="p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
