import { db } from '../../db/index';
import { agents, userAgents, conversations, messages, agentTasks, type Agent, type NewAgent } from '../../db/schema';
import { eq, or, isNull, desc } from 'drizzle-orm';
import type { AgentData } from '@fishtank/server-protocol';
import * as AgentVersionService from './AgentVersionService';

/**
 * Check if a string is a valid UUID
 */
function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Get all agents for a user (their own + public + system default agents)
 */
export async function getUserAgents(userId: string): Promise<AgentData[]> {
  // For anonymous users or invalid UUIDs, just return public agents + system default + legacy agents
  if (!isValidUUID(userId)) {
    const result = await db
      .select()
      .from(agents)
      .where(or(
        eq(agents.isPublic, true),
        eq(agents.isSystemDefault, true),
        isNull(agents.ownerId)  // Legacy agents with no owner
      ));
    return result.map(agentToData);
  }

  // Get agents:
  // - Owned by this user
  // - Public agents (shared by others)
  // - System default agents (platform-wide)
  // - Legacy agents (no owner, for backwards compat)
  const result = await db
    .select()
    .from(agents)
    .where(or(
      eq(agents.ownerId, userId),
      eq(agents.createdById, userId),  // Backwards compat
      eq(agents.isPublic, true),
      eq(agents.isSystemDefault, true),
      isNull(agents.ownerId)
    ));

  return result.map(agentToData);
}

/**
 * Get a single agent by ID
 */
export async function getAgent(agentId: string): Promise<AgentData | null> {
  const result = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return result[0] ? agentToData(result[0]) : null;
}

/**
 * Create a new agent
 */
export async function createAgent(
  userId: string,
  data: {
    id?: string;
    name: string;
    description?: string;
    systemPrompt?: string;
    isPublic?: boolean;
  }
): Promise<AgentData> {
  const validUserId = isValidUUID(userId) ? userId : undefined;

  const newAgent: NewAgent = {
    name: data.name,
    description: data.description,
    systemPrompt: data.systemPrompt,
    isPublic: data.isPublic ?? false,
    createdById: validUserId,
    ownerId: validUserId,
    version: 1,
  };

  try {
    const result = await db.insert(agents).values(newAgent).returning();
    const agent = result[0];

    // Also add to userAgents junction table
    if (validUserId) {
      await db.insert(userAgents).values({
        userId: validUserId,
        agentId: agent.id,
      });
    }

    // Create initial version snapshot
    if (validUserId) {
      await AgentVersionService.createVersion({
        agentId: agent.id,
        userId: validUserId,
        reason: 'initial',
        notes: 'Initial agent creation',
      });
    }

    console.log(`[AgentService] Created agent ${agent.id} for user ${userId}`);
    return agentToData(agent);
  } catch (error) {
    console.error(`[AgentService] Failed to create agent:`, error);
    throw error;
  }
}

/**
 * Update an existing agent
 */
export async function updateAgent(
  agentId: string,
  userId: string,
  data: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    isPublic?: boolean;
  }
): Promise<AgentData | null> {
  // Get existing agent
  const existing = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!existing[0]) return null;

  // Check if user can modify this agent
  const canModify = await AgentVersionService.canModifyAgent(userId, agentId);
  if (!canModify) {
    console.log(`[AgentService] User ${userId} not authorized to update agent ${agentId}`);
    return null;
  }

  // Create version snapshot before update if systemPrompt changed
  if (data.systemPrompt !== undefined && isValidUUID(userId)) {
    await AgentVersionService.incrementVersion({
      agentId,
      userId,
      reason: 'manual_update',
      notes: `Updated by user`,
    });
  }

  const updates: Partial<Agent> = {
    updatedAt: new Date(),
  };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.systemPrompt !== undefined) updates.systemPrompt = data.systemPrompt;
  if (data.isPublic !== undefined) updates.isPublic = data.isPublic;

  const result = await db.update(agents).set(updates).where(eq(agents.id, agentId)).returning();

  console.log(`[AgentService] Updated agent ${agentId}`);
  return result[0] ? agentToData(result[0]) : null;
}

/**
 * Delete an agent and all associated data
 */
export async function deleteAgent(agentId: string, userId: string): Promise<boolean> {
  // Get existing agent
  const existing = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!existing[0]) return false;

  // Cannot delete system default agents
  if (existing[0].isSystemDefault) {
    console.log(`[AgentService] Cannot delete system default agent ${agentId}`);
    return false;
  }

  // Check if user can modify this agent
  const canModify = await AgentVersionService.canModifyAgent(userId, agentId);
  if (!canModify) {
    console.log(`[AgentService] User ${userId} not authorized to delete agent ${agentId}`);
    return false;
  }

  // Delete in order to respect foreign key constraints
  await AgentVersionService.deleteAgentVersions(agentId);

  const agentConversations = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.agentId, agentId));

  const conversationIds = agentConversations.map(c => c.id);

  if (conversationIds.length > 0) {
    for (const convId of conversationIds) {
      await db.delete(messages).where(eq(messages.conversationId, convId));
    }
  }

  await db.delete(agentTasks).where(eq(agentTasks.agentId, agentId));
  await db.delete(conversations).where(eq(conversations.agentId, agentId));
  await db.delete(userAgents).where(eq(userAgents.agentId, agentId));
  await db.delete(agents).where(eq(agents.id, agentId));

  console.log(`[AgentService] Deleted agent ${agentId} with ${conversationIds.length} conversations`);
  return true;
}

/**
 * Convert Agent DB type to AgentData protocol type
 */
function agentToData(agent: Agent): AgentData {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || undefined,
    systemPrompt: agent.systemPrompt || undefined,
    isPublic: agent.isPublic || undefined,
    ownerId: agent.ownerId || undefined,
    isSystemDefault: agent.isSystemDefault || undefined,
    version: agent.version || 1,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

// ============================================================================
// Conversation Management
// ============================================================================

export async function addMessage(
  conversationId: string,
  role: 'user' | 'agent' | 'system',
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await db.insert(messages).values({
    conversationId,
    role,
    content,
    metadata: metadata || null,
  });
}

export async function getAgentConversation(agentId: string): Promise<{
  conversationId: string | null;
  messages: Array<{ role: string; content: string; createdAt: string; senderId?: string; senderName?: string }>;
}> {
  const conv = await db
    .select()
    .from(conversations)
    .where(eq(conversations.agentId, agentId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (!conv[0]) {
    return { conversationId: null, messages: [] };
  }

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv[0].id))
    .orderBy(messages.createdAt);

  return {
    conversationId: conv[0].id,
    messages: msgs.map((m) => {
      const metadata = m.metadata as Record<string, unknown> | null;
      return {
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        senderId: metadata?.senderId as string | undefined,
        senderName: metadata?.senderName as string | undefined,
      };
    }),
  };
}
