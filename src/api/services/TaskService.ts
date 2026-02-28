import { db, agentTasks, agents, users, conversations, messages, tasks } from '../../db/index';
import { eq, and, desc, asc } from 'drizzle-orm';
import type { AgentTask, NewAgentTask, Message, Task, NewTask } from '../../db/schema';
import type { TaskData, TaskStatus, TaskBrowserState } from '@fishtank/server-protocol';

// Default agent for ad-hoc tasks
const DEFAULT_AGENT_NAME = 'Custom Task';
let defaultAgentId: string | null = null;

/**
 * Get or create the default agent for ad-hoc tasks
 */
async function getDefaultAgentId(): Promise<string> {
  if (defaultAgentId) return defaultAgentId;

  // Check if default agent exists
  const existing = await db
    .select()
    .from(agents)
    .where(eq(agents.name, DEFAULT_AGENT_NAME))
    .limit(1);

  if (existing.length > 0) {
    defaultAgentId = existing[0].id;
    return defaultAgentId;
  }

  // Create default agent
  const result = await db
    .insert(agents)
    .values({
      name: DEFAULT_AGENT_NAME,
      description: 'Default agent for custom browser automation tasks',
      isPublic: true,
    })
    .returning({ id: agents.id });

  defaultAgentId = result[0].id;
  console.log(`[TaskService] Created default agent: ${defaultAgentId}`);
  return defaultAgentId;
}

/**
 * Get or create user by ID (for anonymous users)
 */
async function ensureUser(userId: string): Promise<string> {
  // Check if user exists
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  // For now, return the userId as-is - the task will reference it
  // In production, you'd want to validate this
  return userId;
}

/**
 * Create a new task in the database
 */
export async function createTask(params: {
  sessionId: string;
  userId: string;
  objective: string;
  maxActions?: number;
  agentName?: string;
  agentId?: string; // Optional: Use specific agent instead of default
}): Promise<{ taskId: string; agentId: string }> {
  // Use provided agentId if valid UUID, otherwise fall back to default
  let agentId: string;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (params.agentId && uuidRegex.test(params.agentId)) {
    agentId = params.agentId;
  } else {
    agentId = await getDefaultAgentId();
  }

  // Try to find a matching user by ID, or use the first admin user as fallback
  let dbUserId: string | null = null;
  try {
    // Check if userId looks like a UUID (database user ID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(params.userId)) {
      const existing = await db.select().from(users).where(eq(users.id, params.userId)).limit(1);
      if (existing.length > 0) {
        dbUserId = existing[0].id;
      }
    }

    // If no valid user found, get the first user from the database
    if (!dbUserId) {
      const anyUser = await db.select().from(users).limit(1);
      if (anyUser.length > 0) {
        dbUserId = anyUser[0].id;
      }
    }
  } catch (err) {
    console.error(`[TaskService] Failed to lookup user:`, err);
  }

  // If still no user, we can't create the task (foreign key constraint)
  if (!dbUserId) {
    throw new Error('No valid user found for task creation');
  }

  try {
    // Let database generate UUID automatically
    const result = await db.insert(agentTasks).values({
      sessionId: params.sessionId,
      userId: dbUserId,
      agentId: agentId,
      objective: params.objective,
      maxActions: params.maxActions || 50,
      status: 'running',
      startedAt: new Date(),
      actionCount: 0,
    }).returning({ id: agentTasks.id });

    const taskId = result[0].id;
    console.log(`[TaskService] Task created: ${taskId}`);
    return { taskId, agentId };
  } catch (error) {
    console.error(`[TaskService] Failed to create task:`, error);
    throw error;
  }
}

/**
 * Update task action count
 */
export async function updateTaskActions(taskId: string, actionCount: number): Promise<void> {
  try {
    await db
      .update(agentTasks)
      .set({ actionCount })
      .where(eq(agentTasks.id, taskId));
  } catch (error) {
    console.error(`[TaskService] Failed to update task actions:`, error);
  }
}

/**
 * Complete a task
 */
export async function completeTask(taskId: string, status: 'completed' | 'failed' | 'cancelled', error?: string): Promise<void> {
  try {
    await db
      .update(agentTasks)
      .set({
        status,
        completedAt: new Date(),
        error: error || null,
      })
      .where(eq(agentTasks.id, taskId));

    console.log(`[TaskService] Task ${status}: ${taskId}`);
  } catch (error) {
    console.error(`[TaskService] Failed to complete task:`, error);
  }
}

/**
 * Get tasks for a user
 */
export async function getTasksByUser(userId: string): Promise<AgentTask[]> {
  if (!isValidUUID(userId)) {
    return [];
  }
  return db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.userId, userId))
    .orderBy(desc(agentTasks.createdAt));
}

/**
 * Get all tasks (for admin)
 */
export async function getAllTasks(): Promise<AgentTask[]> {
  return db
    .select()
    .from(agentTasks)
    .orderBy(desc(agentTasks.createdAt));
}

/**
 * Get task by ID
 */
export async function getTask(taskId: string): Promise<AgentTask | null> {
  const result = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId))
    .limit(1);

  return result[0] || null;
}

/**
 * Update task's current URL (for session restoration)
 */
export async function updateTaskCurrentUrl(taskId: string, currentUrl: string): Promise<void> {
  try {
    await db
      .update(agentTasks)
      .set({ currentUrl })
      .where(eq(agentTasks.id, taskId));
  } catch (error) {
    console.error(`[TaskService] Failed to update task currentUrl:`, error);
  }
}

/**
 * Get or create a conversation for a task
 * Creates a new conversation for each task (tasks own conversations now)
 * For context continuity across tasks, use the new work session task system.
 */
export async function createTaskConversation(params: {
  taskId: string;
  userId: string;
  agentId: string;
  title: string;
}): Promise<string> {
  try {
    // Check if this agentTask already has a conversation
    const existingTask = await db
      .select({ conversationId: agentTasks.conversationId })
      .from(agentTasks)
      .where(eq(agentTasks.id, params.taskId))
      .limit(1);

    if (existingTask[0]?.conversationId) {
      console.log(`[TaskService] Reusing existing conversation: ${existingTask[0].conversationId} for task: ${params.taskId}`);
      return existingTask[0].conversationId;
    }

    // Create new conversation for this task
    const result = await db.insert(conversations).values({
      userId: params.userId,
      agentId: params.agentId,
      title: params.title,
      status: 'active',
    }).returning({ id: conversations.id });

    const conversationId = result[0].id;

    // Link conversation to task
    await db
      .update(agentTasks)
      .set({ conversationId })
      .where(eq(agentTasks.id, params.taskId));

    console.log(`[TaskService] New conversation created: ${conversationId} for task: ${params.taskId}, agent: ${params.agentId}`);
    return conversationId;
  } catch (error) {
    console.error(`[TaskService] Failed to create/get conversation:`, error);
    throw error;
  }
}

/**
 * Add a thought/action to the task conversation
 */
export async function addTaskThought(params: {
  conversationId: string;
  thought: string;
  action?: unknown;
}): Promise<void> {
  try {
    await db.insert(messages).values({
      conversationId: params.conversationId,
      role: 'agent',
      content: params.thought,
      metadata: params.action ? { action: params.action } : null,
    });

    // Update conversation timestamp
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, params.conversationId));
  } catch (error) {
    console.error(`[TaskService] Failed to add thought:`, error);
  }
}

/**
 * Add a user message to the task conversation
 */
export async function addUserMessage(params: {
  conversationId: string;
  content: string;
}): Promise<void> {
  try {
    await db.insert(messages).values({
      conversationId: params.conversationId,
      role: 'user',
      content: params.content,
      metadata: null,
    });

    // Update conversation timestamp
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, params.conversationId));
  } catch (error) {
    console.error(`[TaskService] Failed to add user message:`, error);
  }
}

/**
 * Get task with conversation history
 */
export async function getTaskWithHistory(taskId: string): Promise<{
  task: AgentTask;
  messages: Message[];
} | null> {
  const task = await getTask(taskId);
  if (!task) return null;

  let taskMessages: Message[] = [];
  if (task.conversationId) {
    taskMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, task.conversationId))
      .orderBy(asc(messages.createdAt));
  }

  return { task, messages: taskMessages };
}

/**
 * Get active/recent tasks for a session (for restoration)
 */
export async function getSessionTasks(sessionId: string): Promise<AgentTask[]> {
  return db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.sessionId, sessionId))
    .orderBy(desc(agentTasks.createdAt));
}

/**
 * Get recent conversation messages for context when making decisions
 * Returns last N messages to provide context to Claude
 */
export async function getRecentConversationMessages(
  conversationId: string,
  limit: number = 20
): Promise<Array<{ role: string; content: string }>> {
  try {
    const recentMessages = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    // Reverse to get chronological order
    return recentMessages.reverse();
  } catch (error) {
    console.error(`[TaskService] Failed to get recent messages:`, error);
    return [];
  }
}

/**
 * Get conversation history for an agent
 * Returns the most recent conversation associated with this agent template.
 * NOTE: In the new model, conversations belong to tasks. This returns the
 * most recently updated conversation that uses this agent for backwards compatibility.
 */
export async function getAgentConversationHistory(agentId: string): Promise<{
  conversationId: string | null;
  messages: Array<{ role: string; content: string; createdAt: string; metadata?: unknown }>;
}> {
  try {
    // Find the most recent conversation for this agent
    const conv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, agentId))
      .orderBy(desc(conversations.updatedAt))
      .limit(1);

    if (!conv[0]) {
      return { conversationId: null, messages: [] };
    }

    const conversationId = conv[0].id;

    // Get messages from the conversation
    const conversationMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    return {
      conversationId,
      messages: conversationMessages.map(m => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        metadata: m.metadata,
      })),
    };
  } catch (error) {
    console.error(`[TaskService] Failed to get agent conversation history:`, error);
    return { conversationId: null, messages: [] };
  }
}

// ============================================================================
// NEW: Work Session Tasks (sidebar items that use agent templates)
// ============================================================================

/**
 * Check if a string is a valid UUID
 */
function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Convert Task DB type to TaskData protocol type
 */
function taskToData(
  task: Task,
  agent?: { name: string; version: number | null; isSystemDefault: boolean | null } | null
): TaskData {
  return {
    id: task.id,
    name: task.name,
    description: task.description || undefined,
    agentId: task.agentId,
    agentName: agent?.name || undefined,
    agentVersionNumber: task.agentVersionNumber || undefined,
    agentVersion: agent?.version || undefined,
    agentIsSystemDefault: agent?.isSystemDefault || undefined,
    status: (task.status || 'idle') as TaskStatus,
    browserState: task.browserState || undefined,
    lastObjective: task.lastObjective || undefined,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    lastActiveAt: task.lastActiveAt?.toISOString(),
  };
}

/**
 * Get all work session tasks for a user
 */
export async function getUserWorkTasks(userId: string): Promise<TaskData[]> {
  if (!isValidUUID(userId)) {
    return [];
  }

  const result = await db
    .select({
      task: tasks,
      agent: agents,
    })
    .from(tasks)
    .leftJoin(agents, eq(tasks.agentId, agents.id))
    .where(eq(tasks.userId, userId))
    .orderBy(desc(tasks.lastActiveAt), desc(tasks.createdAt));

  return result.map(({ task, agent }) => taskToData(task, agent));
}

/**
 * Get a single work session task by ID
 */
export async function getWorkTask(taskId: string): Promise<TaskData | null> {
  const result = await db
    .select({
      task: tasks,
      agent: agents,
    })
    .from(tasks)
    .leftJoin(agents, eq(tasks.agentId, agents.id))
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!result[0]) return null;
  return taskToData(result[0].task, result[0].agent);
}

/**
 * Create a new work session task
 * Pins the current agent version at creation time
 */
export async function createWorkTask(
  userId: string,
  data: {
    name: string;
    agentId: string;
    description?: string;
  }
): Promise<TaskData> {
  // Verify agent exists
  const agent = await db.select().from(agents).where(eq(agents.id, data.agentId)).limit(1);
  if (!agent[0]) {
    throw new Error(`Agent ${data.agentId} not found`);
  }

  // Create task - pin the current agent version
  const newTask: NewTask = {
    name: data.name,
    description: data.description,
    agentId: data.agentId,
    userId: isValidUUID(userId) ? userId : data.agentId,
    status: 'idle',
    agentVersionNumber: agent[0].version || 1, // Pin to current version
  };

  const result = await db.insert(tasks).values(newTask).returning();
  const task = result[0];

  // Create initial conversation linked to this task
  await db
    .insert(conversations)
    .values({
      taskId: task.id,
      userId: isValidUUID(userId) ? userId : task.id,
      agentId: data.agentId,
      title: data.name,
      status: 'active',
    });

  console.log(`[TaskService] Created work task ${task.id} for user ${userId} (pinned to agent v${task.agentVersionNumber})`);
  return taskToData(task, agent[0]);
}

/**
 * Update an existing work session task
 */
export async function updateWorkTask(
  taskId: string,
  userId: string,
  data: {
    name?: string;
    description?: string;
    status?: TaskStatus;
    browserState?: TaskBrowserState;
    lastObjective?: string;
  }
): Promise<TaskData | null> {
  // Verify ownership
  const existing = await db
    .select({
      task: tasks,
      agent: agents,
    })
    .from(tasks)
    .leftJoin(agents, eq(tasks.agentId, agents.id))
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!existing[0]) return null;

  const isOwner = existing[0].task.userId === userId;
  if (!isOwner) {
    console.log(`[TaskService] User ${userId} not authorized to update work task ${taskId}`);
    return null;
  }

  const updates: Partial<Task> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.status !== undefined) updates.status = data.status;
  if (data.browserState !== undefined) updates.browserState = data.browserState;
  if (data.lastObjective !== undefined) updates.lastObjective = data.lastObjective;

  if (data.status === 'working') {
    updates.lastActiveAt = new Date();
  }

  const result = await db.update(tasks).set(updates).where(eq(tasks.id, taskId)).returning();

  console.log(`[TaskService] Updated work task ${taskId}`);
  return result[0] ? taskToData(result[0], existing[0].agent) : null;
}

/**
 * Delete a work session task and all associated data
 */
export async function deleteWorkTask(taskId: string, userId: string): Promise<boolean> {
  // Verify ownership
  const existing = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!existing[0]) return false;

  const isOwner = existing[0].userId === userId;
  if (!isOwner) {
    console.log(`[TaskService] User ${userId} not authorized to delete work task ${taskId}`);
    return false;
  }

  // Get conversations for this task
  const taskConversations = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.taskId, taskId));

  // Delete messages for those conversations
  for (const conv of taskConversations) {
    await db.delete(messages).where(eq(messages.conversationId, conv.id));
  }

  // Delete conversations
  await db.delete(conversations).where(eq(conversations.taskId, taskId));

  // Delete the task
  await db.delete(tasks).where(eq(tasks.id, taskId));

  console.log(`[TaskService] Deleted work task ${taskId}`);
  return true;
}

/**
 * Get conversation history for a work session task
 */
export async function getWorkTaskConversation(taskId: string): Promise<{
  conversationId: string | null;
  messages: Array<{ role: string; content: string; createdAt: string; metadata?: unknown }>;
}> {
  const conv = await db
    .select()
    .from(conversations)
    .where(eq(conversations.taskId, taskId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (!conv[0]) {
    return { conversationId: null, messages: [] };
  }

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv[0].id))
    .orderBy(asc(messages.createdAt));

  return {
    conversationId: conv[0].id,
    messages: msgs.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      metadata: m.metadata || undefined,
    })),
  };
}

/**
 * Add a message to a work session task's conversation
 */
export async function addWorkTaskMessage(
  taskId: string,
  role: 'user' | 'agent' | 'system',
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  // Get or create conversation for this task
  let conv = await db
    .select()
    .from(conversations)
    .where(eq(conversations.taskId, taskId))
    .limit(1);

  if (!conv[0]) {
    // Create conversation
    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task[0]) throw new Error(`Task ${taskId} not found`);

    const newConv = await db
      .insert(conversations)
      .values({
        taskId,
        userId: task[0].userId,
        agentId: task[0].agentId,
        title: task[0].name,
        status: 'active',
      })
      .returning();
    conv = newConv;
  }

  await db.insert(messages).values({
    conversationId: conv[0].id,
    role,
    content,
    metadata: metadata || null,
  });

  // Update conversation timestamp
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conv[0].id));
}
