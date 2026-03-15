/**
 * AgentVersionService
 *
 * Manages agent version history. When an agent is updated, a new version
 * snapshot is created. Tasks pin to a specific version at creation time.
 */

import { db } from '../../db/index';
import { agents, agentVersions, adminUsers, type AgentVersionReason } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { AgentVersionData } from '@runhq/server-protocol';

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Check if a string is a valid UUID
 */
function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Check if a user is an admin via the admin_users table.
 */
export async function isAdmin(userId: string): Promise<boolean> {
  if (!isValidUUID(userId)) return false;
  const result = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId))
    .limit(1);
  return result.length > 0;
}

/**
 * Check if a user can modify an agent
 * - Owners can modify their own agents
 * - Admins can modify system default agents
 * - Legacy agents (no owner) can be modified by anyone (for backwards compat)
 */
export async function canModifyAgent(userId: string, agentId: string): Promise<boolean> {
  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent[0]) return false;

  // System default agents can only be modified by admins
  if (agent[0].isSystemDefault) {
    return await isAdmin(userId);
  }

  // Check if user is the owner
  if (agent[0].ownerId === userId) {
    return true;
  }

  // Legacy: Allow modification if agent has no owner
  if (!agent[0].ownerId && !agent[0].createdById) {
    return true;
  }

  // Check if user created it (backwards compat)
  if (agent[0].createdById === userId) {
    return true;
  }

  return false;
}

// ============================================================================
// Version Management
// ============================================================================

/**
 * Create a new version snapshot for an agent
 * Called automatically when an agent is updated
 */
export async function createVersion(params: {
  agentId: string;
  userId: string;
  reason: AgentVersionReason;
  notes?: string;
}): Promise<AgentVersionData | null> {
  try {
    // Get current agent state
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, params.agentId))
      .limit(1);

    if (!agent[0]) {
      console.error(`[AgentVersionService] Agent not found: ${params.agentId}`);
      return null;
    }

    // Get the current version number
    const currentVersion = agent[0].version || 1;

    // Create the version snapshot (v2: no config)
    const result = await db
      .insert(agentVersions)
      .values({
        agentId: params.agentId,
        versionNumber: currentVersion,
        graphDefinition: agent[0].graphDefinition,
        systemPrompt: agent[0].systemPrompt,
        createdById: params.userId,
        reason: params.reason,
        notes: params.notes,
      })
      .returning();

    const version = result[0];
    console.log(`[AgentVersionService] Created version ${currentVersion} for agent ${params.agentId}`);

    return versionToData(version);
  } catch (error) {
    console.error(`[AgentVersionService] Failed to create version:`, error);
    return null;
  }
}

/**
 * Get all versions for an agent
 */
export async function getVersions(agentId: string): Promise<AgentVersionData[]> {
  try {
    const result = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(desc(agentVersions.versionNumber));

    return result.map(versionToData);
  } catch (error) {
    console.error(`[AgentVersionService] Failed to get versions:`, error);
    return [];
  }
}

/**
 * Get a specific version by agent ID and version number
 */
export async function getVersion(
  agentId: string,
  versionNumber: number
): Promise<AgentVersionData | null> {
  try {
    const result = await db
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, agentId),
          eq(agentVersions.versionNumber, versionNumber)
        )
      )
      .limit(1);

    return result[0] ? versionToData(result[0]) : null;
  } catch (error) {
    console.error(`[AgentVersionService] Failed to get version:`, error);
    return null;
  }
}

/**
 * Get the system prompt for a specific version
 * Used when loading a task that's pinned to a specific version
 */
export async function getVersionPrompt(
  agentId: string,
  versionNumber: number
): Promise<string | null> {
  const version = await getVersion(agentId, versionNumber);
  return version?.systemPrompt || null;
}

/**
 * Increment agent version and create a snapshot
 * Called when an agent is updated
 */
export async function incrementVersion(params: {
  agentId: string;
  userId: string;
  reason: AgentVersionReason;
  notes?: string;
}): Promise<number> {
  try {
    // First create a snapshot of the current state
    await createVersion(params);

    // Then increment the version number
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, params.agentId))
      .limit(1);

    const newVersion = (agent[0]?.version || 1) + 1;

    await db
      .update(agents)
      .set({ version: newVersion, updatedAt: new Date() })
      .where(eq(agents.id, params.agentId));

    console.log(`[AgentVersionService] Incremented agent ${params.agentId} to version ${newVersion}`);
    return newVersion;
  } catch (error) {
    console.error(`[AgentVersionService] Failed to increment version:`, error);
    throw error;
  }
}

/**
 * Delete all versions for an agent (called when agent is deleted)
 */
export async function deleteAgentVersions(agentId: string): Promise<void> {
  try {
    await db
      .delete(agentVersions)
      .where(eq(agentVersions.agentId, agentId));

    console.log(`[AgentVersionService] Deleted all versions for agent ${agentId}`);
  } catch (error) {
    console.error(`[AgentVersionService] Failed to delete versions:`, error);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function versionToData(version: typeof agentVersions.$inferSelect): AgentVersionData {
  return {
    id: version.id,
    agentId: version.agentId,
    versionNumber: version.versionNumber,
    systemPrompt: version.systemPrompt || undefined,
    createdById: version.createdById || undefined,
    reason: (version.reason as AgentVersionData['reason']) || 'manual_update',
    notes: version.notes || undefined,
    createdAt: version.createdAt.toISOString(),
  };
}
