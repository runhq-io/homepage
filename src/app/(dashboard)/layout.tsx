import { auth } from '@/lib/auth';
import { DashboardChrome } from '@/components/DashboardChrome';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const user = session?.user ?? null;

  return (
    <div className="min-h-screen overflow-x-hidden">
      {/* Subtle animated background glow (same style as homepage) */}
      <div className="bw-animated-bg" aria-hidden="true" />

      <DashboardChrome user={user}>{children}</DashboardChrome>
    </div>
  );
}
