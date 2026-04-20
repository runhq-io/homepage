// ============================================================================
// Redesign: Projects, Typed Channels, Agents, Tasks (Todos), Jobs
// ============================================================================
// Project = lightweight category (name, icon, color) that groups channels
// Channel = typed content area (chat, todo, browser) within a project
// AgentEntity = persistent server-wide identity (tools, prompt, model)
// Todo = community-upvoted work item linked to a todo-type channel
// Job = long-lived execution context where an agent works on a todo
// ============================================================================

// --- Channel Types ---

export type AppChannelType = 'chat' | 'todo' | 'browser' | 'files';

/** Default channels created when a new project is created */
export const DEFAULT_PROJECT_CHANNELS: { type: AppChannelType; name: string }[] = [
  { type: 'files', name: 'files' },
];

// --- Projects ---

export interface Project {
  id: string;
  serverId: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  startingFolder?: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  // Populated on read
  activeJobs?: Job[];
  channels?: Channel[];
  // @deprecated — retained for backward compatibility during migration
  description?: string | null;
}

export interface CreateProjectInput {
  name: string;
  serverId: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
}

export interface UpdateProjectInput {
  name?: string;
  icon?: string | null;
  color?: string | null;
  startingFolder?: string | null;
  sortOrder?: number;
}

// --- Agent Entities ---

export interface AgentEntity {
  id: string;
  serverId: string;
  name: string;
  description?: string | null;
  character?: AgentCharacter | null;
  systemPrompt?: string | null;
  model?: string | null;
  enabledTools: string[];
  browserBackend?: string | null;
  startingFolder?: string | null;
  startingCommand?: string | null;
  /** Command template to run in terminal on job launch. Supports {{TASK_ID}}, {{ALL_TASK_DETAILS}}, etc. */
  jobStartCommand?: string | null;
  pinnedChat?: boolean;
  capabilities?: string | null;
  memory?: Record<string, unknown> | null;
  runtime: AgentRuntime;
  config?: Record<string, unknown> | null;
  autoStartTasks: boolean;
  undeletable: boolean;
  sortOrder: number;
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt: number;
  updatedAt: number;
  // Derived (populated on read)
  activeJobs?: Job[];
  activeJobCount?: number;
  currentStatus?: AgentStatus;
}

export interface CreateAgentEntityInput {
  name: string;
  serverId: string;
  description?: string;
  character?: AgentCharacter;
  systemPrompt?: string;
  model?: string;
  enabledTools?: string[];
  browserBackend?: string;
  startingFolder?: string;
  startingCommand?: string;
  jobStartCommand?: string;
  pinnedChat?: boolean;
  capabilities?: string;
  runtime?: AgentRuntime;
  config?: Record<string, unknown>;
  autoStartTasks?: boolean;
}

export interface UpdateAgentEntityInput {
  name?: string;
  description?: string | null;
  character?: AgentCharacter | null;
  systemPrompt?: string | null;
  model?: string | null;
  enabledTools?: string[];
  browserBackend?: string | null;
  startingFolder?: string | null;
  startingCommand?: string | null;
  jobStartCommand?: string | null;
  capabilities?: string | null;
  memory?: Record<string, unknown> | null;
  runtime?: AgentRuntime;
  config?: Record<string, unknown> | null;
  pinnedChat?: boolean;
  autoStartTasks?: boolean;
  sortOrder?: number;
}

// --- Service Credentials ---

/** Service credential metadata (auto-unlocked, no master password) */
export interface ServiceCredential {
  id: string;
  serverId: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}

/** Service credential with decrypted content */
export interface ServiceCredentialWithContent extends ServiceCredential {
  content: Record<string, string>;
}

// --- Todos (project todo list items) ---

export type TodoStatus = 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled';
export type TodoType = 'regular' | 'delayed' | 'scheduled';
export type TodoVisibility = 'public' | 'private';

export interface TodoAttachment {
  filename: string;
  mimeType: string;
  originalName?: string;
  storageProvider?: 'workspace-local' | 'r2' | 's3';
  storageKey?: string;
  canonicalAttachmentId?: string | null;
  url?: string | null;
}

export interface GitVoteData {
  yes: string;
  no: string;
  totalVoters: number;
  quorumReached: boolean;
  votingEndsAt: string;
}

export interface Todo {
  id: string;
  serverId: string;
  canonicalTaskId?: string | null;
  canonicalTaskSyncedAt?: number | null;
  visibility?: TodoVisibility;
  /** The todo-type channel this todo belongs to */
  channelId: string;
  /** @deprecated — use channelId instead; retained for backward compatibility during migration */
  projectId?: string;
  title: string;
  description?: string | null;
  status: TodoStatus;
  upvotes: number;
  sortOrder: number;
  upvotedByMe?: boolean;
  assignedAgentId?: string | null;
  jobId?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
  isArchived?: boolean;
  isDeleted?: boolean;
  isPinned?: boolean;
  commentsDisabled?: boolean;
  attachments?: TodoAttachment[] | null;
  type: TodoType;
  schedule?: string | null;
  scheduledAt?: number | null;
  timezone?: string | null;
  sourceType?: 'native' | 'gitvote' | 'widget';
  sourceId?: string | null;
  sourceUrl?: string | null;
  sourceVoteData?: GitVoteData | null;
  // Populated on read
  assignedAgent?: AgentEntity;
  job?: Job;
}

export interface CreateTodoInput {
  /** The todo-type channel to create this todo in */
  channelId: string;
  /** @deprecated — use channelId instead */
  projectId?: string;
  visibility?: TodoVisibility;
  title?: string;
  description?: string;
  attachments?: TodoAttachment[];
  type?: TodoType;
  schedule?: string;
  scheduledAt?: number;
  timezone?: string;
  sourceType?: 'native' | 'gitvote' | 'widget';
  sourceId?: string;
  sourceUrl?: string;
  sourceVoteData?: GitVoteData;
}

export interface UpdateTodoInput {
  visibility?: TodoVisibility;
  title?: string;
  description?: string | null;
  status?: TodoStatus;
  sortOrder?: number;
  attachments?: TodoAttachment[] | null;
  channelId?: string; // Move todo to a different channel
  isArchived?: boolean;
  isDeleted?: boolean;
  isPinned?: boolean;
  commentsDisabled?: boolean;
  type?: TodoType;
  schedule?: string | null;
  scheduledAt?: number | null;
  timezone?: string | null;
  sourceVoteData?: GitVoteData | null;
}

export interface TodoComment {
  id: string;
  todoId: string;
  content: string;
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt: number;
  attachments?: TodoAttachment[] | null;
}

// --- Activity Log ---

export type ActivityType =
  | 'comment'
  | 'task_created'
  | 'status_change'
  | 'agent_assigned'
  | 'agent_unassigned'
  | 'task_archived'
  | 'task_unarchived'
  | 'task_deleted';

export interface ActivityLogEntry {
  id: string;
  todoId: string;
  type: ActivityType;
  content?: string | null;
  metadata?: Record<string, any> | null;
  attachments?: TodoAttachment[] | null;
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt: number;
  // Populated via join for server-wide queries
  todoTitle?: string;
  todoChannelId?: string;
}

// --- Canonical workspace/public tasks (BE-backed) ---

export type CanonicalTaskStatus = TodoStatus;
export type CanonicalTaskType = TodoType;
export type CanonicalTaskVisibility = 'public' | 'private';
export type CanonicalTaskSourceType = 'workspace' | 'widget';
export type CanonicalTaskActorType = 'member' | 'external' | 'system' | 'agent';

export interface CanonicalTaskAttachment {
  id: string;
  taskId: string;
  ownerType: 'task' | 'comment' | 'activity';
  ownerId: string;
  storageProvider: 'workspace-local' | 'r2' | 's3';
  storageKey: string;
  mimeType: string;
  originalName?: string | null;
  legacyWorkspaceAttachmentKey?: string | null;
  url?: string | null;
  createdAt: string;
}

export interface CanonicalTask {
  id: string;
  serverId: string;
  workspaceProjectId?: string | null;
  workspaceChannelId?: string | null;
  title: string;
  description?: string | null;
  status: CanonicalTaskStatus;
  visibility: CanonicalTaskVisibility;
  sourceType: CanonicalTaskSourceType;
  createdByType: CanonicalTaskActorType;
  createdById?: string | null;
  createdByName?: string | null;
  commentsDisabled: boolean;
  type: CanonicalTaskType;
  schedule?: string | null;
  scheduledAt?: number | null;
  timezone?: string | null;
  completedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  legacyWorkspaceTodoId?: string | null;
  upvoteCount: number;
  downvoteCount?: number;
  moderationStatus?: 'pending' | 'approved' | 'rejected';
  votingEndsAt?: string | null;
  upvotedByMe?: boolean;
  attachments?: CanonicalTaskAttachment[] | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalTaskComment {
  id: string;
  taskId: string;
  content: string;
  createdByType: CanonicalTaskActorType;
  createdById?: string | null;
  createdByName?: string | null;
  legacyWorkspaceCommentId?: string | null;
  attachments?: CanonicalTaskAttachment[] | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface CanonicalTaskActivityEntry {
  id: string;
  taskId: string;
  type: ActivityType;
  content?: string | null;
  metadata?: Record<string, any> | null;
  createdByType: CanonicalTaskActorType;
  createdById?: string | null;
  createdByName?: string | null;
  legacyWorkspaceActivityId?: string | null;
  attachments?: CanonicalTaskAttachment[] | null;
  createdAt: string;
}

export interface CanonicalTaskAttachmentInput {
  storageProvider: 'workspace-local' | 'r2' | 's3';
  storageKey: string;
  mimeType: string;
  originalName?: string | null;
  legacyWorkspaceAttachmentKey?: string | null;
}

export interface CanonicalTaskMigrationAttachmentInput {
  ownerType: 'task' | 'comment' | 'activity';
  ownerLegacyId: string;
  legacyWorkspaceAttachmentKey: string;
  storageProvider: 'workspace-local' | 'r2' | 's3';
  storageKey: string;
  mimeType: string;
  originalName?: string | null;
}

export interface CanonicalTaskMigrationCommentInput {
  legacyWorkspaceCommentId: string;
  content: string;
  createdByType: CanonicalTaskActorType;
  createdById?: string | null;
  createdByName?: string | null;
  createdAt: number;
  updatedAt?: number;
  deletedAt?: number | null;
  attachments?: CanonicalTaskMigrationAttachmentInput[];
}

export interface CanonicalTaskMigrationActivityInput {
  legacyWorkspaceActivityId: string;
  type: ActivityType;
  content?: string | null;
  metadata?: Record<string, any> | null;
  createdByType: CanonicalTaskActorType;
  createdById?: string | null;
  createdByName?: string | null;
  createdAt: number;
  attachments?: CanonicalTaskMigrationAttachmentInput[];
}

export interface CanonicalTaskMigrationBundle {
  legacyWorkspaceTodoId: string;
  workspaceProjectId?: string | null;
  workspaceChannelId?: string | null;
  title: string;
  description?: string | null;
  status: CanonicalTaskStatus;
  visibility: CanonicalTaskVisibility;
  sourceType: CanonicalTaskSourceType;
  createdByType: CanonicalTaskActorType;
  createdById?: string | null;
  createdByName?: string | null;
  commentsDisabled: boolean;
  type: CanonicalTaskType;
  schedule?: string | null;
  scheduledAt?: number | null;
  timezone?: string | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
  upvoteCount: number;
  createdAt: number;
  updatedAt: number;
  attachments?: CanonicalTaskMigrationAttachmentInput[];
  comments?: CanonicalTaskMigrationCommentInput[];
  activity?: CanonicalTaskMigrationActivityInput[];
}

export interface CanonicalTaskMigrationResult {
  legacyWorkspaceTodoId: string;
  canonicalTaskId: string;
  created: boolean;
  commentsUpserted: number;
  activityUpserted: number;
  attachmentsUpserted: number;
}

export interface CanonicalTaskMigrationSummary {
  serverId: string;
  tasks: number;
  comments: number;
  activity: number;
  attachments: number;
  lastTaskUpdatedAt?: string | null;
}

export interface MemberStats {
  userId: string;
  userName: string;
  isAgent: boolean;
  tasksCreated: number;
  tasksCompleted: number;
  agentsAssigned: number;
  comments: number;
}

export interface MemberActivityEntry {
  userId: string;
  userName: string;
  isAgent: boolean;
  total: number;
  created: number;
  completed: number;
  assigned: number;
  comments: number;
}

export interface MemberActivityBucket {
  period: string;
  members: MemberActivityEntry[];
}

export interface MemberActivityResponse {
  buckets: MemberActivityBucket[];
}

// --- Jobs ---

export interface Job {
  id: string;
  serverId: string;
  projectId: string;
  agentId: string;
  todoId?: string | null;
  name?: string | null;
  status: JobStatus;
  statusSummary?: string | null;
  objective?: string | null;
  result?: string | null;
  error?: string | null;
  currentNode?: string | null;
  currentNodeType?: string | null;
  activeModality?: Modality | null;
  executionType?: ExecutionType | null;
  gitBranch?: string | null;
  gitWorktreePath?: string | null;
  previewUrl?: string | null;
  previewPort?: number | null;
  lastSeen?: number | null;
  openclawPort?: number | null;
  openclawPid?: number | null;
  nextCheckAt?: number | null;
  summary?: string | null;
  configSnapshot?: JobAgentConfig | null;
  channelId?: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  closedAt?: number | null;
  // Populated on read
  agent?: AgentEntity;
  todo?: Todo;
  project?: Project;
}

/** Agent config snapshot stored on a job at creation time */
export interface JobAgentConfig {
  systemPrompt?: string | null;
  model?: string | null;
  character?: AgentCharacter | null;
  enabledTools?: string[];
  browserBackend?: string | null;
  runtime?: AgentRuntime;
  config?: Record<string, unknown> | null;
}

export interface CreateJobInput {
  agentId: string;
  projectId: string;
  todoId?: string;
  name?: string;
  createBranch?: boolean; // default false — when true, creates a git branch for isolation
}

// --- Job Conversation Types ---

export interface JobConversation {
  id: string;
  jobId: string;
  title?: string | null;
  createdAt: number;
}

export interface JobMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

// --- New Subscription Channels ---

export type RedesignSubscriptionChannel = 'projects' | 'todos' | 'jobs';

// ============================================================================
// Legacy: Unified Agent Model (deprecated — use AgentEntity + Job)
// ============================================================================
// Kept for backward compatibility during migration.
// ============================================================================

export type AgentStatus = 'idle' | 'working' | 'needs_help' | 'completed';
export type JobStatus = 'idle' | 'working' | 'running' | 'needs_help' | 'completed';
export type ExecutionType = 'local' | 'ssh' | 'cloud';
export type Modality = 'browser' | 'terminal' | 'ssh' | 'files' | 'chat';
export type AgentCharacter = 'bot' | 'dog' | 'fish' | 'lobster' | 'man' | 'witch' | 'woman' | 'worker';
export type AgentRuntime = 'peonbot' | 'openclaw';

export interface Agent {
  id: string;
  serverId: string;

  // Identity
  name: string;
  jobTitle: string | null;

  // Persona/Configuration
  systemPrompt: string | null;
  model: string | null;
  config: Record<string, unknown> | null;
  character: AgentCharacter | null;

  // Status
  status: AgentStatus;
  statusSummary: string | null;

  // Work
  objective: string | null;
  result: string | null;
  error: string | null;

  // Runtime state (for real-time UI)
  currentNode: string | null;
  currentNodeType: string | null;
  activeModality: Modality | null;

  // Execution environment
  executionType: ExecutionType | null;
  capabilities: string[] | null;
  lastSeen: Date | null;

  // Flags
  undeletable: boolean;
  /** When true, use the system prompt as-is without injecting platform/behavioral rules */
  rawSystemPrompt: boolean;

  // Monitoring
  monitoringIntervalMs: number | null;
  monitoringTarget: 'browser' | 'terminal' | 'auto' | null;
  nextCheckAt: number | null;

  // Category (for organizing agents in sidebar)
  categoryId: string | null;
  sortOrder: number;

  /** @deprecated Use categoryId */
  groupId: string | null;

  // Runtime type (peonbot or openclaw)
  runtime: AgentRuntime;

  // OpenClaw-specific fields (only set when runtime === 'openclaw')
  openclawPort: number | null;
  openclawPid: number | null;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

// ============================================================================
// Categories (unified sidebar organization for agents + channels)
// ============================================================================

/** @deprecated Use Project */
export interface Category {
  id: string;
  serverId: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
}

/** @deprecated Use Project */
export type AgentGroup = Category;

// ============================================================================
// Conversations & Messages
// ============================================================================

export interface Conversation {
  id: string;
  agentId: string;
  createdAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

// Simplified chat message for API responses
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  // Sender info for multiplayer - identifies who sent the message
  senderId?: string;
  senderName?: string;
}

// ============================================================================
// Server Info
// ============================================================================

export interface ServerInfo {
  id: string;
  serverId: string;
  name: string | null;
  version: string;
  createdAt: Date;
}

// ============================================================================
// Input Types
// ============================================================================

export interface CreateAgentInput {
  name: string;
  serverId: string;
  jobTitle?: string;
  systemPrompt?: string;
  model?: string;
  config?: Record<string, unknown>;
  character?: AgentCharacter;
  objective?: string;
  executionType?: ExecutionType;
  capabilities?: string[];
  categoryId?: string;
  /** @deprecated Use categoryId */
  groupId?: string;
  runtime?: AgentRuntime; // defaults to 'peonbot'
  /** When true, use the system prompt as-is without injecting platform/behavioral rules */
  rawSystemPrompt?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  jobTitle?: string;
  systemPrompt?: string;
  model?: string;
  config?: Record<string, unknown>;
  character?: AgentCharacter;
  status?: AgentStatus;
  statusSummary?: string | null;
  objective?: string;
  result?: string;
  error?: string;
  currentNode?: string | null;
  currentNodeType?: string | null;
  activeModality?: Modality | null;
  executionType?: ExecutionType;
  capabilities?: string[];
  lastSeen?: Date;
  categoryId?: string | null;
  /** @deprecated Use categoryId */
  groupId?: string | null;
  // Monitoring configuration
  monitoringIntervalMs?: number | null;
  monitoringTarget?: 'browser' | 'terminal' | 'auto' | null;
  sortOrder?: number;
  /** When true, use the system prompt as-is without injecting platform/behavioral rules */
  rawSystemPrompt?: boolean;
}

export interface CreateCategoryInput {
  name: string;
  serverId: string;
  sortOrder?: number;
}

export interface UpdateCategoryInput {
  name?: string;
  sortOrder?: number;
}

/** @deprecated Use CreateCategoryInput */
export type CreateAgentGroupInput = CreateCategoryInput;

/** @deprecated Use UpdateCategoryInput */
export type UpdateAgentGroupInput = UpdateCategoryInput;

// ============================================================================
// WebSocket Protocol
// ============================================================================

export type SubscriptionChannel = 'agents' | 'messages' | 'chat' | 'channels' | 'projects' | 'todos' | 'jobs';

// Client → Server messages
export type ClientMessage =
  | { type: 'auth'; token?: string }
  | { type: 'subscribe'; channels: SubscriptionChannel[] }
  | { type: 'unsubscribe'; channels: SubscriptionChannel[] }
  | { type: 'ping' }
  | { type: 'presence:set_name'; userName: string }
  | { type: 'presence:set_focus'; channelId: string | null; jobId?: string | null }
  // Agent operations
  | { type: 'agent:create'; data: CreateAgentInput }
  | { type: 'agent:update'; agentId: string; data: UpdateAgentInput }
  | { type: 'agent:delete'; agentId: string }
  | { type: 'agent:start'; agentId: string; prompt?: string }
  | { type: 'agent:stop'; agentId: string }
  | { type: 'agent:viewed'; agentId: string }
  // Channel operations (unified)
  | { type: 'channel:create'; data: CreateChannelInput }
  | { type: 'channel:update'; channelId: string; data: UpdateChannelInput }
  | { type: 'channel:delete'; channelId: string }
  // Category operations
  | { type: 'category:create'; data: CreateCategoryInput }
  | { type: 'category:update'; categoryId: string; data: UpdateCategoryInput }
  | { type: 'category:delete'; categoryId: string }
  // Group operations (deprecated, mapped to category)
  | { type: 'group:create'; data: CreateCategoryInput }
  | { type: 'group:update'; groupId: string; data: UpdateCategoryInput }
  | { type: 'group:delete'; groupId: string }
  // Channel agent management
  | { type: 'channel:add_agent'; channelId: string; agentChannelId: string }
  | { type: 'channel:remove_agent'; channelId: string; agentChannelId: string }
  // Browser screencast
  | { type: 'screencast:subscribe'; agentId: string }
  | { type: 'screencast:unsubscribe'; agentId: string }
  // Project operations (redesign)
  | { type: 'project:create'; data: CreateProjectInput }
  | { type: 'project:update'; projectId: string; data: UpdateProjectInput }
  | { type: 'project:delete'; projectId: string }
  | { type: 'project:link_repo'; projectId: string; repoUrl: string; branch?: string }
  | { type: 'project:unlink_repo'; projectId: string }
  // Agent entity operations (redesign — server-wide agents)
  | { type: 'agent_entity:create'; data: CreateAgentEntityInput }
  | { type: 'agent_entity:update'; agentId: string; data: UpdateAgentEntityInput }
  | { type: 'agent_entity:delete'; agentId: string }
  // Todo operations (redesign — project todo list)
  | { type: 'todo:create'; data: CreateTodoInput }
  | { type: 'todo:update'; todoId: string; data: UpdateTodoInput }
  | { type: 'todo:delete'; todoId: string }
  | { type: 'todo:upvote'; todoId: string }
  | { type: 'todo:assign'; todoId: string; agentId: string }
  // Job operations (redesign)
  | { type: 'job:create'; data: CreateJobInput }
  | { type: 'job:close'; jobId: string }
  | { type: 'job:start'; jobId: string; prompt?: string }
  | { type: 'job:stop'; jobId: string }
  | { type: 'job:resume'; jobId: string; message?: string }
  | { type: 'job:viewed'; jobId: string }
  | { type: 'screencast:subscribe_session'; sessionId: string }
  | { type: 'screencast:unsubscribe_session'; sessionId: string };

// Server → Client messages
export type ServerMessage =
  | { type: 'subscribed'; channels: SubscriptionChannel[] }
  | { type: 'unsubscribed'; channels: SubscriptionChannel[] }
  | { type: 'pong' }
  | { type: 'error'; message: string; code?: string }
  // Agent events
  | { type: 'agent:created'; agent: Agent }
  | { type: 'agent:updated'; agent: Agent }
  | { type: 'agent:deleted'; agentId: string }
  | { type: 'agent:message'; agentId: string; message: ChatMessage }
  // Channel events (unified)
  | { type: 'channel:created'; channel: Channel }
  | { type: 'channel:updated'; channel: Channel }
  | { type: 'channel:deleted'; channelId: string }
  // Category events
  | { type: 'category:created'; category: Category }
  | { type: 'category:updated'; category: Category }
  | { type: 'category:deleted'; categoryId: string }
  // Group events (deprecated, kept for backward compat)
  | { type: 'group:created'; group: Category }
  | { type: 'group:updated'; group: Category }
  | { type: 'group:deleted'; groupId: string }
  // Streaming
  | { type: 'stream:start'; agentId: string }
  | { type: 'stream:chunk'; agentId: string; chunk: string }
  | { type: 'stream:end'; agentId: string }
  // Tool execution events
  | { type: 'tool:start'; agentId: string; tool: { name: string; input: Record<string, unknown> } }
  | { type: 'tool:end'; agentId: string; tool: { name: string }; result: ToolResultMessage }
  // Server-side tool events (Claude's built-in tools like web_search)
  | { type: 'server_tool:used'; agentId: string; toolName: string; input: Record<string, unknown>; result: unknown }
  // Claude events
  | { type: 'claude:thinking'; agentId: string; text: string }
  | { type: 'claude:response'; agentId: string; text: string }
  // State changes
  | { type: 'state:waiting_for_user'; agentId: string; question: string; reason?: string }
  | { type: 'state:waiting_for_choice'; agentId: string; question: string; options: string[]; context?: string; allowCustom: boolean }
  | { type: 'state:complete'; agentId: string; summary: string }
  | { type: 'state:error'; agentId: string; error: string }
  // Screenshots
  | { type: 'screenshot:updated'; agentId: string; screenshot: ScreenshotMessage }
  // Browser screencast (live streaming)
  | { type: 'screencast:frame'; agentId: string; data: string; metadata: { timestamp: number; width: number; height: number } }
  | { type: 'screencast:started'; agentId: string }
  | { type: 'screencast:stopped'; agentId: string }
  // Terminal activity events
  | { type: 'terminal:cli-detected'; agentId: string; sessionId: string; cliName: string; cliIcon: string }
  // Channel agent events
  | { type: 'channel:agent_added'; channelId: string; agentChannel: Channel }
  | { type: 'channel:agent_removed'; channelId: string; agentChannelId: string }
  | { type: 'chat:agent_typing'; channelId: string; agentChannelId: string; agentName: string }
  // Presence
  | { type: 'presence:update'; users: ConnectedUser[] }
  // Project events (redesign)
  | { type: 'project:created'; project: Project }
  | { type: 'project:updated'; project: Project }
  | { type: 'project:deleted'; projectId: string }
  // Agent entity events (redesign)
  | { type: 'agent_entity:created'; agent: AgentEntity }
  | { type: 'agent_entity:updated'; agent: AgentEntity }
  | { type: 'agent_entity:deleted'; agentId: string }
  // Todo events (redesign)
  | { type: 'todo:created'; todo: Todo }
  | { type: 'todo:updated'; todo: Todo }
  | { type: 'todo:deleted'; todoId: string }
  | { type: 'todo:upvoted'; todo: Todo }
  | { type: 'todo:assigned'; todo: Todo }
  // Job events (redesign)
  | { type: 'job:created'; job: Job }
  | { type: 'job:updated'; job: Job }
  | { type: 'job:closed'; jobId: string }
  | { type: 'job:message'; jobId: string; message: ChatMessage }
  | { type: 'job:tool_start'; jobId: string; tool: { name: string; input: Record<string, unknown> } }
  | { type: 'job:tool_end'; jobId: string; tool: { name: string }; result: ToolResultMessage }
  | { type: 'job:thinking'; jobId: string; text: string }
  | { type: 'job:response'; jobId: string; text: string }
  | { type: 'job:screenshot'; jobId: string; screenshot: ScreenshotMessage }
  | { type: 'job:stream_start'; jobId: string }
  | { type: 'job:stream_end'; jobId: string }
  | { type: 'job:server_tool_used'; jobId: string; toolName: string; input: Record<string, unknown>; result: unknown }
  | { type: 'job:state_waiting_for_user'; jobId: string; question: string; reason?: string }
  | { type: 'job:state_waiting_for_choice'; jobId: string; question: string; options: string[]; context?: string; allowCustom: boolean }
  | { type: 'job:state_complete'; jobId: string; summary: string }
  | { type: 'job:state_error'; jobId: string; error: string }
  | { type: 'job:screencast_frame'; jobId: string; data: string; metadata: { timestamp: number; width: number; height: number } }
  | { type: 'job:screencast_started'; jobId: string }
  | { type: 'job:screencast_stopped'; jobId: string };

export interface ConnectedUser {
  userId: string;
  name: string;
  avatar?: string;
  focusedChannelId?: string | null;
  focusedJobId?: string | null;
  connectedAt: Date;
}

// ============================================================================
// Tool Events (for WebSocket)
// ============================================================================

export interface ToolResultMessage {
  success: boolean;
  error?: string;
  output?: string;
  exitCode?: number;
  screenshot?: ScreenshotMessage;
  waitingForUser?: boolean;
  completed?: boolean;
  summary?: string;
}

export interface ScreenshotMessage {
  imageBase64: string;
  url?: string;
  title?: string;
  width?: number;
  height?: number;
  tabs?: TabInfoMessage[];
}

export interface TabInfoMessage {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
}

export interface InfoResponse {
  serverId: string;
  name: string | null;
  version: string;
  authMode: 'none' | 'token' | 'cloud';
  previewDomain?: string | null;
}

export interface StatusResponse {
  activeSessions: {
    terminals: number;
    browsers: number;
  };
}

// ============================================================================
// Project Settings
// ============================================================================

/**
 * Tool category names that can be enabled/disabled
 */
export type ToolCategory =
  | 'browser'
  | 'terminal'
  | 'ssh'
  | 'user'
  | 'login'
  | 'monitoring'
  | 'configuration'
  | 'memory'
  | 'tasks'
  | 'files'
  | 'project'
  | 'operator'
  | 'skills';

/**
 * Browser backend options
 */
export type BrowserBackend = 'browserbase' | 'playwright';

/**
 * Domain-specific browser rule
 */
export interface BrowserDomainRule {
  domain: string;                          // Domain pattern (e.g., "x.com", "twitter.com")
  backend: BrowserBackend;                 // Which backend to use
  persistSession?: boolean;                // Keep login state across runs
}

/**
 * Project-level settings for persona and tools
 */
export interface ServerSettings {
  id: string;
  serverId: string;
  defaultSystemPrompt: string | null;
  enabledToolCategories: Record<ToolCategory, boolean> | null;
  browserBackend: BrowserBackend;
  browserDomainRules: BrowserDomainRule[];
  logChannelId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for updating server settings
 */
export interface UpdateServerSettingsInput {
  defaultSystemPrompt?: string | null;
  enabledToolCategories?: Record<ToolCategory, boolean> | null;
  browserBackend?: BrowserBackend;
  browserDomainRules?: BrowserDomainRule[];
  logChannelId?: string | null;
}

// ============================================================================
// Vault (Project-scoped encrypted credentials)
// ============================================================================

/**
 * Content type for vault items
 */
export type VaultContentType = 'text' | 'structured' | 'file';

/**
 * Vault status
 */
export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

/**
 * Vault item (decrypted for display - never includes actual secrets)
 */
export interface VaultItem {
  id: string;
  serverId: string;
  label: string;
  contentType: VaultContentType;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Vault item with decrypted content (only returned when unlocked)
 */
export interface VaultItemWithContent extends VaultItem {
  content: string | Record<string, unknown>;
}

/**
 * Input for creating a vault item
 */
export interface CreateVaultItemInput {
  label: string;
  contentType: VaultContentType;
  description?: string;
  content: string | Record<string, unknown>;
}

/**
 * Input for updating a vault item
 */
export interface UpdateVaultItemInput {
  label?: string;
  description?: string;
  content?: string | Record<string, unknown>;
}

/**
 * Vault status response
 */
export interface VaultStatusResponse {
  status: VaultStatus;
  autoLockTimeout: number | null;
  itemCount: number;
}

// ============================================================================
// Chat Channels (Discord-style text channels)
// ============================================================================

/** 'terminal' is deprecated — legacy terminal channels are now treated as agent channels by the client */
export type ChannelFeature = 'chat' | 'preview' | 'agent' | 'agents' | 'terminal';

export const DEFAULT_CHANNEL_FEATURES: ChannelFeature[] = ['chat', 'agents'];

export const CHANNEL_FEATURE_CONFIG: Record<ChannelFeature, { label: string; description: string }> = {
  chat: { label: 'Chat', description: 'Text messaging between members' },
  preview: { label: 'Preview', description: 'Live preview of a dev server' },
  agent: { label: 'Agent', description: 'AI agent execution environment' },
  agents: { label: 'Agents', description: 'Allow AI agents to participate in this channel' },
  terminal: { label: 'Terminal', description: 'Dedicated terminal and file browsing' },
};

export interface ChatChannel {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  previewUrl: string | null;
  enabledFeatures: ChannelFeature[] | null;
  isPrivate: boolean;
  categoryId: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt?: string;
  agentConfig?: AgentConfig | null;
  agentRuntime?: AgentRuntimeState | null;
}

// ============================================================================
// Unified Channel (replaces separate Agent + ChatChannel)
// ============================================================================

export interface AgentConfig {
  systemPrompt?: string | null;
  model?: string | null;
  character?: AgentCharacter | null;
  runtime?: AgentRuntime;
  config?: Record<string, unknown> | null;
  undeletable?: boolean;
  monitoringIntervalMs?: number | null;
  monitoringTarget?: 'browser' | 'terminal' | 'auto' | null;
  startingFolder?: string | null;
  startingCommand?: string | null;
  /** Command template to run in terminal on job launch. Supports {{TASK_ID}}, {{ALL_TASK_DETAILS}}, etc. */
  jobStartCommand?: string | null;
  /** Tool panels to auto-open when the channel loads (e.g. ['terminal', 'browser', 'files']) */
  startupTools?: string[] | null;
  /** Per-agent browser backend override ('browserbase' | 'playwright') */
  browserBackend?: string | null;
  /** When true, use the system prompt as-is without injecting platform/behavioral rules */
  rawSystemPrompt?: boolean;
  /** Shell command(s) to run in the terminal when a preview channel loads (e.g. "npm run dev") */
  previewStartCommand?: string | null;
}

export interface AgentRuntimeState {
  channelId: string;
  status: AgentStatus;
  statusSummary?: string | null;
  objective?: string | null;
  result?: string | null;
  error?: string | null;
  currentNode?: string | null;
  currentNodeType?: string | null;
  activeModality?: Modality | null;
  executionType?: ExecutionType | null;
  capabilities?: string[] | null;
  lastSeen?: string | null;
  openclawPort?: number | null;
  openclawPid?: number | null;
  nextCheckAt?: number | null;
  summary?: string | null;
}

/** Unified Channel — replaces both Agent and ChatChannel */
export interface Channel {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  /** Channel content type: chat, todo, or browser */
  type: AppChannelType;
  enabledFeatures: ChannelFeature[];
  previewUrl: string | null;
  isPrivate: boolean;
  /** The project (category) this channel belongs to */
  projectId: string | null;
  /** @deprecated — use projectId instead */
  categoryId: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  agentConfig: AgentConfig | null;
  agentRuntime: AgentRuntimeState | null;
}

export interface CreateChannelInput {
  name: string;
  serverId: string;
  description?: string;
  /** Channel content type — defaults to 'chat' if omitted */
  type?: AppChannelType;
  enabledFeatures?: ChannelFeature[];
  previewUrl?: string;
  isPrivate?: boolean;
  /** The project (category) to place this channel in */
  projectId?: string;
  /** @deprecated — use projectId instead */
  categoryId?: string;
  agentConfig?: AgentConfig;
  /** Shortcut: initial objective for agent channels */
  objective?: string;
}

export interface UpdateChannelInput {
  name?: string;
  description?: string | null;
  enabledFeatures?: ChannelFeature[];
  previewUrl?: string | null;
  isPrivate?: boolean;
  /** Move channel to a different project (category) */
  projectId?: string | null;
  /** @deprecated — use projectId instead */
  categoryId?: string | null;
  sortOrder?: number;
  agentConfig?: AgentConfig | null;
}

export interface ChatMessageAttachment {
  type: 'image';
  ref: string;
  mimeType: string;
}

export interface ChatChannelMessage {
  id: string;
  channelId: string;
  userId: string;
  userName: string;
  content: string;
  agentChannelId?: string | null;
  attachments?: ChatMessageAttachment[] | null;
  createdAt: string;
  editedAt?: string | null;
  deleted?: boolean;
}

// ============================================================================
// Channel Agent Membership
// ============================================================================

export interface ChannelAgentMembership {
  channelId: string;
  agentChannelId: string;
  joinedAt: number;
}

// ============================================================================
// Group Chat Coordinator Types
// ============================================================================

export type CoordinatorAction = 'ignore' | 'respond' | 'todo' | 'work' | 'command' | 'cancel';

export interface CoordinatorAssignment {
  agent: string;
  action: CoordinatorAction;
  task: string | null;
  reason: string | null;
}

// ============================================================================
// Roles & Permissions (Discord-style)
// ============================================================================

export type PermissionFlag =
  | 'administrator'
  | 'view_channel'
  | 'send_messages'
  | 'manage_messages'
  | 'manage_channel'
  | 'mention_everyone'
  | 'pin_messages'
  | 'view_agent'
  | 'interact_agent'
  | 'manage_agent'
  | 'delete_agent'
  | 'manage_category'
  | 'manage_roles'
  // Project permissions (redesign)
  | 'manage_project'
  | 'view_preview'
  | 'view_todos'
  | 'create_todo'
  | 'comment_todo'
  | 'upvote_todo'
  | 'manage_todos'
  | 'manage_jobs';

export type PermissionSet = Partial<Record<PermissionFlag, boolean>>;

export const DEFAULT_EVERYONE_PERMISSIONS: PermissionSet = {
  administrator: false,
  view_channel: true,
  send_messages: true,
  manage_messages: false,
  manage_channel: false,
  mention_everyone: false,
  pin_messages: false,
  view_agent: false,
  interact_agent: false,
  manage_agent: false,
  delete_agent: false,
  manage_category: false,
  manage_roles: false,
};

export const ALL_PERMISSIONS: PermissionSet = {
  administrator: true,
  view_channel: true,
  send_messages: true,
  manage_messages: true,
  manage_channel: true,
  mention_everyone: true,
  pin_messages: true,
  view_agent: true,
  interact_agent: true,
  manage_agent: true,
  delete_agent: true,
  manage_category: true,
  manage_roles: true,
  manage_project: true,
  view_preview: true,
  create_todo: true,
  comment_todo: true,
  upvote_todo: true,
  manage_todos: true,
  manage_jobs: true,
};

export interface ServerRole {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  position: number;
  permissions: PermissionSet;
  isEveryone: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserRoleAssignment {
  id: string;
  serverId: string;
  userId: string;
  roleId: string;
  assignedAt: string;
}

export interface ChannelRoleOverride {
  id: string;
  channelId: string;
  roleId: string;
  allow: PermissionSet;
  deny: PermissionSet;
  createdAt: string;
}

export interface CreateRoleInput {
  name: string;
  color?: string;
  position?: number;
  permissions?: PermissionSet;
}

export interface UpdateRoleInput {
  name?: string;
  color?: string;
  position?: number;
  permissions?: PermissionSet;
}

export interface CategoryRoleOverride {
  id: string;
  categoryId: string;
  roleId: string;
  allow: PermissionSet;
  deny: PermissionSet;
  createdAt: string;
}

export interface AgentRoleOverride {
  id: string;
  agentId: string;
  roleId: string;
  allow: PermissionSet;
  deny: PermissionSet;
  createdAt: string;
}

export interface SetChannelOverrideInput {
  roleId: string;
  allow?: PermissionSet;
  deny?: PermissionSet;
}

export interface SetCategoryOverrideInput {
  roleId: string;
  allow?: PermissionSet;
  deny?: PermissionSet;
}

export interface SetAgentOverrideInput {
  roleId: string;
  allow?: PermissionSet;
  deny?: PermissionSet;
}

export interface ProjectRoleOverride {
  id: string;
  projectId: string;
  roleId: string;
  allow: PermissionSet;
  deny: PermissionSet;
  createdAt: string;
}

export interface SetProjectOverrideInput {
  roleId: string;
  allow?: PermissionSet;
  deny?: PermissionSet;
}

// ============================================================================
// Channel Types (for external messaging integration)
// ============================================================================

export * from './channels.js';

// ============================================================================
// MCP Server Configuration
// ============================================================================

/**
 * MCP server configuration for an individual server
 */
export interface MCPServerConfig {
  command: string;          // Path to executable or command
  args?: string[];          // Command line arguments
  env?: Record<string, string>; // Environment variables
  cwd?: string;             // Working directory
  enabled?: boolean;        // Whether this server is enabled (default: true)
  /** Service credential ID for secret env vars (decrypted at spawn time) */
  credentialId?: string;
}

/**
 * MCP servers configuration for an agent
 */
export interface AgentMCPConfig {
  servers: Record<string, MCPServerConfig>;
}

/**
 * Extended agent config with MCP support
 */
export interface AgentConfigWithMCP {
  mcp?: AgentMCPConfig;
  [key: string]: unknown;
}

// ============================================================================
// Cloud API Protocol Types (Desktop ↔ Cloud WebSocket)
// ============================================================================

// Job identifier
export type JobId = string;

// ============================================================================
// Cloud Data Types
// ============================================================================

export interface AgentData {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  isPublic?: boolean;
  ownerId?: string;
  isSystemDefault?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = 'idle' | 'working' | 'paused' | 'completed' | 'error';

export interface TaskBrowserState {
  currentUrl?: string;
  tabs?: string[];
}

export interface TaskData {
  id: string;
  name: string;
  description?: string;
  agentId: string;
  agentName?: string;
  agentVersionNumber?: number;
  agentVersion?: number;
  agentIsSystemDefault?: boolean;
  status: TaskStatus;
  browserState?: TaskBrowserState;
  lastObjective?: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  model?: string;
  costCents: number;
}

export type AgentVersionReason = 'manual_update' | 'improvement' | 'publish' | 'import' | 'initial';

export interface AgentVersionData {
  id: string;
  agentId: string;
  versionNumber: number;
  systemPrompt?: string;
  createdById?: string;
  reason: AgentVersionReason;
  notes?: string;
  createdAt: string;
}

export interface Screenshot {
  imageBase64: string;
  url?: string;
  title?: string;
  timestamp?: number;
  width?: number;
  height?: number;
}

// ============================================================================
// Cloud Auth Messages
// ============================================================================

export interface AuthMessage {
  type: 'auth';
  token: string;
  sessionId?: JobId;
}

export interface AuthResultMessage {
  type: 'auth_result';
  success: boolean;
  userId?: string;
  error?: string;
  /** Workspace name whose MFA policy triggered the block (only set when error === 'MFA_REQUIRED'). */
  workspaceName?: string;
  /** ISO-8601 timestamp of the MFA grace-period deadline (only set when error === 'MFA_REQUIRED'). */
  deadline?: string;
  timestamp: number;
}

// ============================================================================
// Cloud Agent CRUD Messages
// ============================================================================

export interface GetAgentsMessage {
  type: 'get_agents';
  timestamp?: number;
}

export interface CreateAgentMessage {
  type: 'create_agent';
  agentId?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  isPublic?: boolean;
  timestamp?: number;
}

export interface UpdateAgentMessage {
  type: 'update_agent';
  agentId: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  isPublic?: boolean;
  timestamp?: number;
}

export interface DeleteAgentMessage {
  type: 'delete_agent';
  agentId: string;
  timestamp?: number;
}

export interface AgentsListMessage {
  type: 'agents_list';
  agents: AgentData[];
  timestamp: number;
}

export interface AgentCreatedMessage {
  type: 'agent_created';
  agent: AgentData;
  timestamp: number;
}

export interface AgentUpdatedMessage {
  type: 'agent_updated';
  agent: AgentData;
  timestamp: number;
}

export interface AgentDeletedMessage {
  type: 'agent_deleted';
  agentId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

// ============================================================================
// Cloud Task CRUD Messages
// ============================================================================

export interface GetTasksMessage {
  type: 'get_tasks';
  timestamp?: number;
}

export interface CreateTaskMessage {
  type: 'create_task';
  name: string;
  agentId: string;
  description?: string;
  timestamp?: number;
}

export interface UpdateTaskMessage {
  type: 'update_task';
  taskId: string;
  name?: string;
  description?: string;
  status?: TaskStatus;
  browserState?: TaskBrowserState;
  lastObjective?: string;
  timestamp?: number;
}

export interface DeleteTaskMessage {
  type: 'delete_task';
  taskId: string;
  timestamp?: number;
}

export interface GetTaskConversationMessage {
  type: 'get_task_conversation';
  taskId: string;
  timestamp?: number;
}

export interface TasksListMessage {
  type: 'tasks_list';
  tasks: TaskData[];
  timestamp: number;
}

export interface TaskCreatedMessage {
  type: 'task_created';
  task: TaskData;
  timestamp: number;
}

export interface TaskUpdatedMessage {
  type: 'task_updated';
  task: TaskData;
  timestamp: number;
}

export interface TaskDeletedMessage {
  type: 'task_deleted';
  taskId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface TaskConversationMessage {
  type: 'task_conversation';
  taskId: string;
  conversationId: string | null;
  messages: Array<{
    role: string;
    content: string;
    createdAt: string;
    metadata?: unknown;
  }>;
  timestamp: number;
}

// ============================================================================
// Cloud Organization Messages
// ============================================================================

export interface OrgInfo {
  id: string;
  name: string;
  slug?: string;
  ownerId: string;
  avatarUrl?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  createdAt: string;
  updatedAt: string;
}

export interface OrgMemberInfo {
  user: { id: string; email: string | null; name: string | null; avatarUrl?: string | null };
  role: 'owner' | 'admin' | 'member' | 'viewer';
  joinedAt: string;
}

export interface PendingInviteInfo {
  token: string;
  orgName: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  expiresAt: string;
}

export interface GetOrgsMessage {
  type: 'get_orgs';
  timestamp?: number;
}

export interface CreateOrgMessage {
  type: 'create_org';
  name: string;
  slug?: string;
  timestamp?: number;
}

export interface UpdateOrgMessage {
  type: 'update_org';
  orgId: string;
  name?: string;
  slug?: string;
  avatarUrl?: string;
  timestamp?: number;
}

export interface DeleteOrgMessage {
  type: 'delete_org';
  orgId: string;
  timestamp?: number;
}

export interface GetOrgMembersMessage {
  type: 'get_org_members';
  orgId: string;
  timestamp?: number;
}

export interface InviteOrgMemberMessage {
  type: 'invite_org_member';
  orgId: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  timestamp?: number;
}

export interface RemoveOrgMemberMessage {
  type: 'remove_org_member';
  orgId: string;
  userId: string;
  timestamp?: number;
}

export interface UpdateOrgMemberRoleMessage {
  type: 'update_org_member_role';
  orgId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  timestamp?: number;
}

export interface LeaveOrgMessage {
  type: 'leave_org';
  orgId: string;
  timestamp?: number;
}

export interface AcceptOrgInviteMessage {
  type: 'accept_org_invite';
  token: string;
  timestamp?: number;
}

export interface GetPendingInvitesMessage {
  type: 'get_pending_invites';
  timestamp?: number;
}

export interface OrgsListMessage {
  type: 'orgs_list';
  orgs: OrgInfo[];
  timestamp: number;
}

export interface OrgCreatedMessage {
  type: 'org_created';
  org: OrgInfo;
  timestamp: number;
}

export interface OrgUpdatedMessage {
  type: 'org_updated';
  org: OrgInfo;
  timestamp: number;
}

export interface OrgDeletedMessage {
  type: 'org_deleted';
  orgId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface OrgMembersListMessage {
  type: 'org_members_list';
  orgId: string;
  members: OrgMemberInfo[];
  timestamp: number;
}

export interface OrgInviteSentMessage {
  type: 'org_invite_sent';
  orgId: string;
  email: string;
  expiresAt: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface OrgMemberRemovedMessage {
  type: 'org_member_removed';
  orgId: string;
  userId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface OrgMemberRoleUpdatedMessage {
  type: 'org_member_role_updated';
  orgId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface OrgLeftMessage {
  type: 'org_left';
  orgId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface OrgInviteAcceptedMessage {
  type: 'org_invite_accepted';
  orgId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface PendingInvitesListMessage {
  type: 'pending_invites_list';
  invites: PendingInviteInfo[];
  timestamp: number;
}

// ============================================================================
// Cloud Task Sharing Messages
// ============================================================================

export interface ShareTaskWithOrgMessage {
  type: 'share_task_with_org';
  taskId: string;
  orgId: string;
  timestamp?: number;
}

export interface UnshareTaskMessage {
  type: 'unshare_task';
  taskId: string;
  timestamp?: number;
}

export interface GetOrgTasksMessage {
  type: 'get_org_tasks';
  orgId: string;
  timestamp?: number;
}

export interface TaskSharedMessage {
  type: 'task_shared';
  taskId: string;
  orgId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface TaskUnsharedMessage {
  type: 'task_unshared';
  taskId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface OrgTasksListMessage {
  type: 'org_tasks_list';
  orgId: string;
  tasks: TaskData[];
  timestamp: number;
}

// ============================================================================
// Cloud Task Streaming Messages (real-time collaboration)
// ============================================================================

export interface SubscribeTaskViewMessage {
  type: 'subscribe_task_view';
  taskId: string;
  timestamp?: number;
}

export interface UnsubscribeTaskViewMessage {
  type: 'unsubscribe_task_view';
  taskId: string;
  timestamp?: number;
}

export interface TaskViewFrameMessage {
  type: 'task_view_frame';
  taskId: string;
  frameType: string;
  data: unknown;
  timestamp?: number;
}

export interface TaskViewSubscribedMessage {
  type: 'task_view_subscribed';
  taskId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface TaskViewUnsubscribedMessage {
  type: 'task_view_unsubscribed';
  taskId: string;
  timestamp: number;
}

export interface TaskViewFrameRelayMessage {
  type: 'task_view_frame_relay';
  taskId: string;
  frameType: string;
  data: unknown;
  fromUserId: string;
  timestamp: number;
}

// ============================================================================
// Cloud Task File Operation Messages
// ============================================================================

export interface TaskFileRequestMessage {
  type: 'task_file_request';
  taskId: string;
  path: string;
  timestamp?: number;
}

export interface TaskFileResponseMessage {
  type: 'task_file_response';
  taskId: string;
  path: string;
  content?: string;
  error?: string;
  timestamp: number;
}

export interface TaskFileRequestRelayMessage {
  type: 'task_file_request_relay';
  taskId: string;
  path: string;
  requesterId: JobId;
  timestamp: number;
}

export interface TaskFileWriteMessage {
  type: 'task_file_write';
  taskId: string;
  path: string;
  content: string;
  timestamp?: number;
}

export interface TaskFileWriteRelayMessage {
  type: 'task_file_write_relay';
  taskId: string;
  path: string;
  content: string;
  requesterId: JobId;
  timestamp: number;
}

export interface TaskFileWriteResultMessage {
  type: 'task_file_write_result';
  taskId: string;
  path: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

// ============================================================================
// Cloud Task Remote Input Messages
// ============================================================================

export interface TaskRemoteInputMessage {
  type: 'task_remote_input';
  taskId: string;
  input: string;
  timestamp?: number;
}

export interface TaskRemoteInputRelayMessage {
  type: 'task_remote_input_relay';
  taskId: string;
  input: string;
  fromUserId: string;
  fromUserName: string;
  timestamp: number;
}

// ============================================================================
// Cloud Agent Action Messages (legacy)
// ============================================================================

export interface AgentActionMessage {
  type: 'agent_action';
  agentId: string;
  action: { type: string; [key: string]: unknown };
  timestamp?: number;
}

export interface StartAgentMessage {
  type: 'start_agent';
  agentId: string;
  objective: string;
  timestamp?: number;
}

export interface StopAgentMessage {
  type: 'stop_agent';
  agentId: string;
  timestamp?: number;
}

export interface ActionResultMessage {
  type: 'action_result';
  success: boolean;
  error?: string;
  output?: string;
  screenshot?: Screenshot;
  timestamp: number;
}

// ============================================================================
// Cloud WebSocket Union Types
// ============================================================================

export type DesktopToCloudMessage =
  | AuthMessage
  | GetAgentsMessage
  | CreateAgentMessage
  | UpdateAgentMessage
  | DeleteAgentMessage
  | GetTasksMessage
  | CreateTaskMessage
  | UpdateTaskMessage
  | DeleteTaskMessage
  | GetTaskConversationMessage
  | GetOrgsMessage
  | CreateOrgMessage
  | UpdateOrgMessage
  | DeleteOrgMessage
  | GetOrgMembersMessage
  | InviteOrgMemberMessage
  | RemoveOrgMemberMessage
  | UpdateOrgMemberRoleMessage
  | LeaveOrgMessage
  | AcceptOrgInviteMessage
  | GetPendingInvitesMessage
  | ShareTaskWithOrgMessage
  | UnshareTaskMessage
  | GetOrgTasksMessage
  | SubscribeTaskViewMessage
  | UnsubscribeTaskViewMessage
  | TaskViewFrameMessage
  | TaskFileRequestMessage
  | TaskFileWriteMessage
  | TaskRemoteInputMessage
  | AgentActionMessage
  | StartAgentMessage
  | StopAgentMessage
  | { type: 'heartbeat' };

export type CloudToDesktopMessage =
  | AuthResultMessage
  | AgentsListMessage
  | AgentCreatedMessage
  | AgentUpdatedMessage
  | AgentDeletedMessage
  | TasksListMessage
  | TaskCreatedMessage
  | TaskUpdatedMessage
  | TaskDeletedMessage
  | TaskConversationMessage
  | OrgsListMessage
  | OrgCreatedMessage
  | OrgUpdatedMessage
  | OrgDeletedMessage
  | OrgMembersListMessage
  | OrgInviteSentMessage
  | OrgMemberRemovedMessage
  | OrgMemberRoleUpdatedMessage
  | OrgLeftMessage
  | OrgInviteAcceptedMessage
  | PendingInvitesListMessage
  | TaskSharedMessage
  | TaskUnsharedMessage
  | OrgTasksListMessage
  | TaskViewSubscribedMessage
  | TaskViewUnsubscribedMessage
  | TaskViewFrameRelayMessage
  | TaskFileResponseMessage
  | TaskFileRequestRelayMessage
  | TaskFileWriteRelayMessage
  | TaskRemoteInputRelayMessage
  | TaskFileWriteResultMessage
  | ActionResultMessage;
