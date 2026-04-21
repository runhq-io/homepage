import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import {
  db,
  users,
  servers,
  serverMembers,
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
  /** Server whose require_mfa policy is driving enforcement (earliest deadline wins). */
  serverId?: string;
  serverName?: string;
  /** @deprecated Alias for serverId, preserved for one release so client code keeps working. */
  workspaceId?: string;
  /** @deprecated Alias for serverName, preserved for one release so client code keeps working. */
  workspaceName?: string;
  deadline?: Date;
}

/**
 * Return enforcement state for the given user based on server memberships.
 *   - 'ok'       = no enforcement, or user has MFA enabled
 *   - 'grace'    = enforced but within the grace period (UI shows banner, access allowed)
 *   - 'required' = enforced past grace (server-scoped routes should block)
 * If the user belongs to multiple servers requiring MFA, the earliest deadline wins.
 *
 * Historically this helper read from organizations/organization_members. The
 * RunHQ client product only exposes "servers" (per-workspace settings), so the
 * policy now lives on the `servers` table.
 */
export async function computeMfaEnforcement(userId: string): Promise<MfaEnforcementState> {
  const [user] = await db.select({ mfaEnabled: users.mfaEnabled })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { status: 'ok' };
  if (user.mfaEnabled) return { status: 'ok' };

  const rows = await db.select({
    serverId: servers.id,
    name: servers.name,
    requireMfa: servers.requireMfa,
    enforcedAt: servers.requireMfaEnforcedAt,
  })
    .from(servers)
    .innerJoin(serverMembers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.userId, userId),
      eq(servers.requireMfa, true),
    ));

  if (rows.length === 0) return { status: 'ok' };

  const graceMs = getMfaGracePeriodMs();
  const now = Date.now();
  let worst: { serverId: string; name: string; deadline: Date; past: boolean } | null = null;
  for (const r of rows) {
    const enforcedAt = r.enforcedAt ? r.enforcedAt.getTime() : now;
    const deadline = new Date(enforcedAt + graceMs);
    const past = now > deadline.getTime();
    if (!worst || deadline < worst.deadline) {
      worst = { serverId: r.serverId, name: r.name, deadline, past };
    }
  }
  if (!worst) return { status: 'ok' };

  return {
    status: worst.past ? 'required' : 'grace',
    serverId: worst.serverId,
    serverName: worst.name,
    // Backward-compat aliases — remove once all client consumers switch to serverId/serverName.
    workspaceId: worst.serverId,
    workspaceName: worst.name,
    deadline: worst.deadline,
  };
}

/**
 * If the user is past grace, return a 403 Response handlers should return.
 * Otherwise return null (handler proceeds).
 *
 * Call this right after auth in every server-scoped route.
 */
export async function enforceMfaOrRespond(
  userId: string,
  corsHeaders: Record<string, string> = {},
): Promise<NextResponse | null> {
  const state = await computeMfaEnforcement(userId);
  if (state.status !== 'required') return null;
  return NextResponse.json({
    error: 'MFA_REQUIRED',
    serverId: state.serverId,
    serverName: state.serverName,
    // Backward-compat aliases — remove once all client consumers switch to serverId/serverName.
    workspaceId: state.serverId,
    workspaceName: state.serverName,
    deadline: state.deadline?.toISOString(),
  }, { status: 403, headers: corsHeaders });
}
