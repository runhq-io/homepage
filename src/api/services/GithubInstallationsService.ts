import { eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { githubAppInstallations, type GithubAppInstallation } from '../../db/schema';

export interface UpsertInstallationInput {
  installationId: number;
  serverId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection?: 'all' | 'selected' | null;
}

export async function upsertInstallation(input: UpsertInstallationInput): Promise<void> {
  await db
    .insert(githubAppInstallations)
    .values({
      installationId: input.installationId,
      serverId: input.serverId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      repositorySelection: input.repositorySelection ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: githubAppInstallations.installationId,
      set: {
        serverId: input.serverId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        repositorySelection: input.repositorySelection ?? null,
        suspendedAt: null,
        updatedAt: new Date(),
      },
    });
}

export async function removeInstallation(installationId: number): Promise<void> {
  await db.delete(githubAppInstallations).where(eq(githubAppInstallations.installationId, installationId));
}

export async function getInstallation(installationId: number): Promise<GithubAppInstallation | null> {
  const rows = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId));
  return rows[0] ?? null;
}

export async function listInstallationsForServer(serverId: string): Promise<GithubAppInstallation[]> {
  return db.select().from(githubAppInstallations).where(eq(githubAppInstallations.serverId, serverId));
}
