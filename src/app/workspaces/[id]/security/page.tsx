import { redirect } from 'next/navigation';
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

  // Enforce workspace MFA policy — even admins must have MFA enabled to
  // manage workspace security once they are past their grace period.
  const mfa = await computeMfaEnforcement(session.user.id);
  if (mfa.status === 'required') {
    redirect('/settings?section=security&mfaRequired=1');
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
