import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { AdminChrome } from '@/components/AdminChrome';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.isAdmin) {
    redirect('/');
  }

  return (
    <div className="min-h-screen overflow-x-hidden">
      {/* Subtle animated background glow (same style as homepage) */}
      <div className="bw-animated-bg" aria-hidden="true" />


      <AdminChrome user={{ name: user?.name ?? null, image: user?.image ?? null }}>{children}</AdminChrome>
    </div>
  );
}
