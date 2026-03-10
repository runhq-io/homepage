import { eq, and } from 'drizzle-orm';
import { db } from './index';
import {
  users, agents, userAgents, conversations, messages, agentTasks,
  type NewUser, type NewAgent, type NewUserAgent, type NewConversation, type NewMessage, type NewAgentTask
} from './schema';

// ============================================================================
// User Services
// ============================================================================

export async function createUser(data: NewUser) {
  const [user] = await db.insert(users).values(data).returning();
  return user;
}

export async function getUserById(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
  });
}

export async function getUserByEmail(email: string) {
  return db.query.users.findFirst({
    where: eq(users.email, email),
  });
}

export async function getUserByUsername(username: string) {
  return db.query.users.findFirst({
    where: eq(users.username, username),
  });
}

export async function getOrCreateUser(email: string, name?: string) {
  let user = await getUserByEmail(email);
  if (!user) {
    user = await createUser({ email, name });
  }
  return user;
}

// ============================================================================
// Agent Services
// ============================================================================

export async function createAgent(data: NewAgent) {
  const [agent] = await db.insert(agents).values(data).returning();
  return agent;
}

export async function getAgentById(id: string) {
  return db.query.agents.findFirst({
    where: eq(agents.id, id),
  });
}

export async function getPublicAgents() {
  return db.query.agents.findMany({
    where: eq(agents.isPublic, true),
  });
}

// ============================================================================
// User-Agent Services
// ============================================================================

export async function addAgentToUser(userId: string, agentId: string, nickname?: string) {
  const [userAgent] = await db.insert(userAgents).values({
    userId,
    agentId,
    nickname,
  }).returning();
  return userAgent;
}

export async function getUserAgents(userId: string) {
  return db.query.userAgents.findMany({
    where: eq(userAgents.userId, userId),
    with: {
      agent: true,
    },
  });
}

export async function removeAgentFromUser(userId: string, agentId: string) {
  await db.delete(userAgents).where(
    and(eq(userAgents.userId, userId), eq(userAgents.agentId, agentId))
  );
}

// ============================================================================
// Conversation Services
// ============================================================================

export async function createConversation(data: NewConversation) {
  const [conversation] = await db.insert(conversations).values(data).returning();
  return conversation;
}

export async function getConversationById(id: string) {
  return db.query.conversations.findFirst({
    where: eq(conversations.id, id),
    with: {
      messages: true,
    },
  });
}

export async function getUserConversations(userId: string) {
  return db.query.conversations.findMany({
    where: eq(conversations.userId, userId),
    orderBy: (conversations, { desc }) => [desc(conversations.updatedAt)],
  });
}

export async function getAgentConversations(userId: string, agentId: string) {
  return db.query.conversations.findMany({
    where: and(eq(conversations.userId, userId), eq(conversations.agentId, agentId)),
    orderBy: (conversations, { desc }) => [desc(conversations.updatedAt)],
  });
}

// ============================================================================
// Message Services
// ============================================================================

export async function addMessage(data: NewMessage) {
  const [message] = await db.insert(messages).values(data).returning();

  // Update conversation updatedAt
  await db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, data.conversationId));

  return message;
}

export async function getConversationMessages(conversationId: string) {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (messages, { asc }) => [asc(messages.createdAt)],
  });
}

// ============================================================================
// Agent Task Services
// ============================================================================

export async function createAgentTask(data: NewAgentTask) {
  const [task] = await db.insert(agentTasks).values(data).returning();
  return task;
}

export async function getAgentTaskById(id: string) {
  return db.query.agentTasks.findFirst({
    where: eq(agentTasks.id, id),
  });
}

export async function updateAgentTask(id: string, data: Partial<NewAgentTask>) {
  const [task] = await db.update(agentTasks)
    .set(data)
    .where(eq(agentTasks.id, id))
    .returning();
  return task;
}

export async function getUserActiveTasks(userId: string) {
  return db.query.agentTasks.findMany({
    where: and(eq(agentTasks.userId, userId), eq(agentTasks.status, 'running')),
  });
}
