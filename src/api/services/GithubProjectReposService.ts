import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import { githubProjectRepos, serverMembers } from '../../db/schema';

export interface ProjectRepoLink {
  serverId: string;
  projectId: string;
  installationId: number;
  owner: string;
  repo: string;
  projectName: string | null;
}

export interface UpsertProjectRepoInput {
  serverId: string;
  projectId: string;
  installationId: number;
  owner: string;
  repo: string;
  projectName?: string | null;
}

/** Mirror a project -> repo link from a server machine. Idempotent (PK = server+project). */
export async function upsertProjectRepo(input: UpsertProjectRepoInput): Promise<void> {
  await db
    .insert(githubProjectRepos)
    .values({
      serverId: input.serverId,
      projectId: input.projectId,
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      projectName: input.projectName ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [githubProjectRepos.serverId, githubProjectRepos.projectId],
      set: {
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        projectName: input.projectName ?? null,
        updatedAt: new Date(),
      },
    });
}

/** Remove a project's repo link (on unlink or project delete). */
export async function removeProjectRepo(serverId: string, projectId: string): Promise<void> {
  await db
    .delete(githubProjectRepos)
    .where(and(eq(githubProjectRepos.serverId, serverId), eq(githubProjectRepos.projectId, projectId)));
}

/** Find all project-repo links for a given GitHub owner/repo (case-insensitive). */
export async function findByOwnerRepo(
  owner: string,
  repo: string,
): Promise<Array<{ serverId: string; projectId: string; installationId: number }>> {
  const rows = await db
    .select({
      serverId: githubProjectRepos.serverId,
      projectId: githubProjectRepos.projectId,
      installationId: githubProjectRepos.installationId,
    })
    .from(githubProjectRepos)
    .where(
      and(
        sql`lower(${githubProjectRepos.owner}) = lower(${owner})`,
        sql`lower(${githubProjectRepos.repo}) = lower(${repo})`,
      ),
    );
  return rows;
}

/** All repo links across every server the given user is a member of. */
export async function listForUser(userId: string): Promise<ProjectRepoLink[]> {
  const rows = await db
    .select({
      serverId: githubProjectRepos.serverId,
      projectId: githubProjectRepos.projectId,
      installationId: githubProjectRepos.installationId,
      owner: githubProjectRepos.owner,
      repo: githubProjectRepos.repo,
      projectName: githubProjectRepos.projectName,
    })
    .from(serverMembers)
    .innerJoin(githubProjectRepos, eq(githubProjectRepos.serverId, serverMembers.serverId))
    .where(eq(serverMembers.userId, userId));
  return rows as ProjectRepoLink[];
}
