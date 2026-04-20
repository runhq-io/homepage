import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import {
  db,
  users,
  organizations,
  organizationMembers,
} from '@/db';

export const MFA_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export interface MfaEnforcementState {
  status: 'ok' | 'grace' | 'required';
  workspaceId?: string;
  workspaceName?: string;
  deadline?: Date;
}

/**
 * Return enforcement state for the given user.
 *   - 'ok'       = no enforcement, or user has MFA enabled
 *   - 'grace'    = enforced but within 7-day grace period (UI shows banner, access allowed)
 *   - 'required' = enforced past grace (workspace-scoped routes should block)
 * If enrolled in multiple requiring workspaces, the earliest deadline wins.
 */
export async function computeMfaEnforcement(userId: string): Promise<MfaEnforcementState> {
  const [user] = await db.select({ mfaEnabled: users.mfaEnabled })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { status: 'ok' };
  if (user.mfaEnabled) return { status: 'ok' };

  const rows = await db.select({
    orgId: organizations.id,
    name: organizations.name,
    requireMfa: organizations.requireMfa,
    enforcedAt: organizations.requireMfaEnforcedAt,
  })
    .from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.orgId, organizations.id))
    .where(and(
      eq(organizationMembers.userId, userId),
      eq(organizations.requireMfa, true),
    ));

  if (rows.length === 0) return { status: 'ok' };

  const now = Date.now();
  let worst: { orgId: string; name: string; deadline: Date; past: boolean } | null = null;
  for (const r of rows) {
    const enforcedAt = r.enforcedAt ? r.enforcedAt.getTime() : now;
    const deadline = new Date(enforcedAt + MFA_GRACE_PERIOD_MS);
    const past = now > deadline.getTime();
    if (!worst || deadline < worst.deadline) {
      worst = { orgId: r.orgId, name: r.name, deadline, past };
    }
  }
  if (!worst) return { status: 'ok' };

  return {
    status: worst.past ? 'required' : 'grace',
    workspaceId: worst.orgId,
    workspaceName: worst.name,
    deadline: worst.deadline,
  };
}

/**
 * If the user is past grace, return a 403 Response handlers should return.
 * Otherwise return null (handler proceeds).
 *
 * Call this right after auth in every workspace-scoped route.
 */
export async function enforceMfaOrRespond(
  userId: string,
  corsHeaders: Record<string, string> = {},
): Promise<NextResponse | null> {
  const state = await computeMfaEnforcement(userId);
  if (state.status !== 'required') return null;
  return NextResponse.json({
    error: 'MFA_REQUIRED',
    workspaceId: state.workspaceId,
    workspaceName: state.workspaceName,
    deadline: state.deadline?.toISOString(),
  }, { status: 403, headers: corsHeaders });
}
