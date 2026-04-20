import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import {
  db,
  users,
  organizations,
  organizationMembers,
} from '@/db';

// Grace period is configurable via env var MFA_GRACE_PERIOD_DAYS.
// Default: 0 (enforce immediately). Set to 7 or more for a rollout period.
// Read per-call (not cached at module load) so env changes take effect
// without restarting, and so tests can set the value after importing.
export function getMfaGracePeriodMs(): number {
  const raw = process.env.MFA_GRACE_PERIOD_DAYS;
  const days = raw !== undefined ? Number(raw) : 0;
  if (!Number.isFinite(days) || days < 0) return 0;
  return days * 24 * 60 * 60 * 1000;
}

/** @deprecated Use getMfaGracePeriodMs() — this constant is only a snapshot at module load. */
export const MFA_GRACE_PERIOD_MS = getMfaGracePeriodMs();

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

  const graceMs = getMfaGracePeriodMs();
  const now = Date.now();
  let worst: { orgId: string; name: string; deadline: Date; past: boolean } | null = null;
  for (const r of rows) {
    const enforcedAt = r.enforcedAt ? r.enforcedAt.getTime() : now;
    const deadline = new Date(enforcedAt + graceMs);
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
