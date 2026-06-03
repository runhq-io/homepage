import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  githubAppInstallations,
  githubInstallationWorkspaces,
  type GithubAppInstallation,
} from '../../db/schema';

export interface UpsertInstallationInput {
  installationId: number;
  /** RunHQ user who authorized the install (audit only). Null when unknown. */
  connectedByUserId: string | null;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection?: 'all' | 'selected' | null;
}

export async function upsertInstallation(input: UpsertInstallationInput): Promise<void> {
  await db
    .insert(githubAppInstallations)
    .values({
      installationId: input.installationId,
      connectedByUserId: input.connectedByUserId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      repositorySelection: input.repositorySelection ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: githubAppInstallations.installationId,
      // connectedByUserId is intentionally NOT in the update set: the connector
      // is recorded once at first connect; re-installs/reconfigures preserve it.
      set: {
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        repositorySelection: input.repositorySelection ?? null,
        suspendedAt: null,
        updatedAt: new Date(),
      },
    });
}

export async function removeInstallation(installationId: number): Promise<void> {
  // Associations cascade-delete via the FK on github_installation_workspaces.
  await db.delete(githubAppInstallations).where(eq(githubAppInstallations.installationId, installationId));
}

export async function getInstallation(installationId: number): Promise<GithubAppInstallation | null> {
  const rows = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId));
  return rows[0] ?? null;
}

/** Make an installation available in a workspace. Idempotent (PK = install+server). */
export async function associateWithWorkspace(
  installationId: number,
  serverId: string,
  addedByUserId: string | null,
): Promise<void> {
  await db
    .insert(githubInstallationWorkspaces)
    .values({ installationId, serverId, addedByUserId, addedAt: new Date() })
    .onConflictDoNothing();
}

export async function isAssociatedWithWorkspace(installationId: number, serverId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(githubInstallationWorkspaces)
    .where(
      and(
        eq(githubInstallationWorkspaces.installationId, installationId),
        eq(githubInstallationWorkspaces.serverId, serverId),
      ),
    );
  return rows.length > 0;
}

/** Installations associated with (available in) a workspace, via the M2M table. */
export async function listInstallationsForServer(serverId: string): Promise<GithubAppInstallation[]> {
  const rows = await db
    .select({
      installationId: githubAppInstallations.installationId,
      connectedByUserId: githubAppInstallations.connectedByUserId,
      accountLogin: githubAppInstallations.accountLogin,
      accountType: githubAppInstallations.accountType,
      repositorySelection: githubAppInstallations.repositorySelection,
      suspendedAt: githubAppInstallations.suspendedAt,
      createdAt: githubAppInstallations.createdAt,
      updatedAt: githubAppInstallations.updatedAt,
    })
    .from(githubInstallationWorkspaces)
    .innerJoin(
      githubAppInstallations,
      eq(githubInstallationWorkspaces.installationId, githubAppInstallations.installationId),
    )
    .where(eq(githubInstallationWorkspaces.serverId, serverId));
  return rows as GithubAppInstallation[];
}

/** Installations a given RunHQ user connected (across all their workspaces). */
export async function listInstallationsForUser(userId: string): Promise<GithubAppInstallation[]> {
  return db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.connectedByUserId, userId));
}
