import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { SecurityForm } from './SecurityForm';
import { db, organizations, organizationMembers, users } from '@/db';
import { eq, and } from 'drizzle-orm';
import { computeMfaEnforcement } from '@/lib/workspaceMfaEnforcement';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/login`);

  const [membership] = await db.select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, session.user.id)))
    .limit(1);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    redirect('/');
  }

  // Enforce workspace MFA policy: even admins must have MFA enabled to manage
  // workspace security once they're past grace. Since MFA setup UI lives in
  // the runhq client SPA (not the Console), we render an explanation with a
  // link rather than redirecting to a dead-end Console route.
  const mfa = await computeMfaEnforcement(session.user.id);
  if (mfa.status === 'required') {
    const clientUrl = process.env.CLIENT_APP_URL || process.env.NEXT_PUBLIC_CLIENT_APP_URL || '';
    const mfaSetupHref = clientUrl ? `${clientUrl}/settings` : '/settings';
    return (
      <section className="max-w-lg mx-auto p-8">
        <div className="border border-red-300 bg-red-50 rounded p-5 mb-4">
          <h1 className="text-xl font-semibold text-red-900 mb-2">
            Two-factor authentication required
          </h1>
          <p className="text-sm text-red-900 mb-3">
            Your workspace{mfa.workspaceName ? ` "${mfa.workspaceName}"` : ''} requires
            all members to use two-factor authentication, and your grace period has ended.
          </p>
          <p className="text-sm text-red-900">
            Enable two-factor authentication to regain access to this page.
          </p>
        </div>
        <Link
          href={mfaSetupHref}
          className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm"
        >
          Go to account settings
        </Link>
      </section>
    );
  }

  const [org] = await db.select({
    requireMfa: organizations.requireMfa,
    enforcedAt: organizations.requireMfaEnforcedAt,
  }).from(organizations).where(eq(organizations.id, orgId)).limit(1);

  const members = await db.select({
    userId: users.id,
    email: users.email,
    name: users.name,
    mfaEnabled: users.mfaEnabled,
  })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId));

  return (
    <SecurityForm
      orgId={orgId}
      initialRequireMfa={org?.requireMfa ?? false}
      initialEnforcedAt={org?.enforcedAt ? org.enforcedAt.toISOString() : null}
      adoption={{
        total: members.length,
        withMfa: members.filter((m) => m.mfaEnabled).length,
        without: members.filter((m) => !m.mfaEnabled).map(({ userId, email, name }) => ({ userId, email, name })),
      }}
    />
  );
}
