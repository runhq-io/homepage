import { DashboardChrome } from '@/components/DashboardChrome';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen overflow-x-hidden">
      {/* Subtle animated background glow (same style as homepage) */}
      <div className="bw-animated-bg" aria-hidden="true" />


      <DashboardChrome>{children}</DashboardChrome>
    </div>
  );
}
