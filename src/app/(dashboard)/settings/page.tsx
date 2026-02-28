import { auth } from '@/lib/auth';
import { db, systemSettings } from '@/db';
import { redirect } from 'next/navigation';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

async function getSettings() {
  const settings = await db.select().from(systemSettings);
  return settings.reduce(
    (acc, s) => ({ ...acc, [s.key]: s.value }),
    {} as Record<string, string | null>
  );
}

export default async function SettingsPage() {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.isAdmin) {
    redirect('/');
  }

  const settings = await getSettings();

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Settings</h1>

      <div className="max-w-2xl">
        <SettingsForm initialSettings={settings} />
      </div>
    </div>
  );
}
