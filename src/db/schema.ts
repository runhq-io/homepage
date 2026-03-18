import { pgTable, text, timestamp, uuid, boolean, jsonb, integer, bigint, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============================================================================
// Billing Plans
// ============================================================================

export type PlanId = 'free' | 'starter' | 'pro' | 'team';

export const plans = pgTable('plans', {
  id: text('id').primaryKey().$type<PlanId>(), // 'free', 'starter', 'pro', 'team'
  name: text('name').notNull(),
  description: text('description'),
  monthlyPriceCents: integer('monthly_price_cents').notNull().default(0),
  // Credits given each month (in cents - $1.00 = 100 cents)
  monthlyCreditsCents: integer('monthly_credits_cents').notNull().default(0),
  maxConcurrentAgents: integer('max_concurrent_agents').notNull().default(1),
  maxServers: integer('max_workspaces').notNull().default(1),
  features: jsonb('features').$type<string[]>(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ============================================================================
// Subscriptions (links users to Stripe)
// ============================================================================

export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull().unique(),
  planId: text('plan_id').references(() => plans.id).notNull().$type<PlanId>(),
  // Stripe fields
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripePriceId: text('stripe_price_id'),
  // Status
  status: text('status').$type<SubscriptionStatus>().notNull().default('active'),
  // Credit balance (in cents - $1.00 = 100 cents)
  creditBalanceCents: integer('credit_balance_cents').notNull().default(0),
  // Billing period
  currentPeriodStart: timestamp('current_period_start'),
  currentPeriodEnd: timestamp('current_period_end'),
  canceledAt: timestamp('canceled_at'),
  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
  plan: one(plans, {
    fields: [subscriptions.planId],
    references: [plans.id],
  }),
}));

// ============================================================================
// Usage Records (persisted token usage per billing period)
// ============================================================================

export const usageRecords = pgTable('usage_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  // Period tracking (monthly)
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  // Token counts
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  // Cost tracking (in cents, with decimal precision)
  totalCostCents: integer('total_cost_cents').notNull().default(0),
  // Request count
  requestCount: integer('request_count').notNull().default(0),
  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  user: one(users, {
    fields: [usageRecords.userId],
    references: [users.id],
  }),
}));

// ============================================================================
// Payments (Stripe payment history)
// ============================================================================

export type PaymentStatus = 'succeeded' | 'pending' | 'failed' | 'refunded';

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
  // Stripe fields
  stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
  stripeInvoiceId: text('stripe_invoice_id'),
  // Amount
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  // Status
  status: text('status').$type<PaymentStatus>().notNull().default('pending'),
  // Metadata
  description: text('description'),
  receiptUrl: text('receipt_url'),
  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const paymentsRelations = relations(payments, ({ one }) => ({
  user: one(users, {
    fields: [payments.userId],
    references: [users.id],
  }),
  subscription: one(subscriptions, {
    fields: [payments.subscriptionId],
    references: [subscriptions.id],
  }),
}));

// ============================================================================
// Users
// ============================================================================

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  username: text('username').unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  passwordHash: text('password_hash'),
  authProvider: text('auth_provider'), // 'google', 'github', 'email'
  authProviderId: text('auth_provider_id'),
  isActivated: boolean('is_activated').default(false), // Requires invite code to activate
  emailVerifiedAt: timestamp('email_verified_at'), // When user verified their email
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  userAgents: many(userAgents),
  conversations: many(conversations),
  tasks: many(tasks),
  subscription: one(subscriptions),
  usageRecords: many(usageRecords),
  payments: many(payments),
  organizationMemberships: many(organizationMembers),
  ownedOrganizations: many(organizations),
}));

// ============================================================================
// Agents (TEMPLATES - reusable state flow definitions)
// ============================================================================

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  systemPrompt: text('system_prompt'),
  isPublic: boolean('is_public').default(false),
  // Ownership and permissions
  createdById: uuid('created_by_id').references(() => users.id),
  ownerId: uuid('owner_id').references(() => users.id), // Current owner (can be transferred)
  isSystemDefault: boolean('is_system_default').default(false), // Platform default agent
  // Legacy: Graph definition (deprecated - now using tool-based agents)
  graphDefinition: jsonb('graph_definition').$type<Record<string, unknown>>(),
  // Version number for tracking changes (increments on each update)
  version: integer('version').default(1),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const agentsRelations = relations(agents, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [agents.createdById],
    references: [users.id],
  }),
  owner: one(users, {
    fields: [agents.ownerId],
    references: [users.id],
  }),
  userAgents: many(userAgents),
  tasks: many(tasks),
  versions: many(agentVersions),
}));

// ============================================================================
// Agent Versions (version history for agents)
// ============================================================================

export type AgentVersionReason = 'manual_update' | 'improvement' | 'publish' | 'import' | 'initial';

export const agentVersions = pgTable('agent_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').references(() => agents.id).notNull(),
  versionNumber: integer('version_number').notNull(), // Sequential: 1, 2, 3...
  // Legacy: Graph snapshot (deprecated)
  graphDefinition: jsonb('graph_definition').$type<Record<string, unknown>>(),
  systemPrompt: text('system_prompt'),
  // Metadata
  createdById: uuid('created_by_id').references(() => users.id),
  reason: text('reason').$type<AgentVersionReason>().default('manual_update'),
  notes: text('notes'), // Optional changelog/description
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const agentVersionsRelations = relations(agentVersions, ({ one }) => ({
  agent: one(agents, {
    fields: [agentVersions.agentId],
    references: [agents.id],
  }),
  createdBy: one(users, {
    fields: [agentVersions.createdById],
    references: [users.id],
  }),
}));

// ============================================================================
// Tasks (CONVERSATIONS - work sessions that use an agent template)
// ============================================================================

export interface TaskBrowserState {
  currentUrl?: string;
  tabs?: string[];
}

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Task identity
  name: text('name').notNull(),
  description: text('description'),
  // Links
  agentId: uuid('agent_id').references(() => agents.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  // Organization sharing (null = personal task, set = shared with org)
  orgId: uuid('org_id').references(() => organizations.id),
  // Agent version pinning - stores the version number at task creation time
  agentVersionNumber: integer('agent_version_number'), // null = use latest
  // Runtime state
  status: text('status').default('idle'), // 'idle', 'working', 'paused', 'completed', 'error'
  browserState: jsonb('browser_state').$type<TaskBrowserState>(),
  lastObjective: text('last_objective'),
  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at'),
});

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  agent: one(agents, {
    fields: [tasks.agentId],
    references: [agents.id],
  }),
  user: one(users, {
    fields: [tasks.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [tasks.orgId],
    references: [organizations.id],
  }),
  conversations: many(conversations),
}));

// ============================================================================
// User-Agent relationship (many-to-many)
// ============================================================================

export const userAgents = pgTable('user_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  agentId: uuid('agent_id').references(() => agents.id).notNull(),
  nickname: text('nickname'), // User's custom name for the agent
  isFavorite: boolean('is_favorite').default(false),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userAgentsRelations = relations(userAgents, ({ one }) => ({
  user: one(users, {
    fields: [userAgents.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [userAgents.agentId],
    references: [agents.id],
  }),
}));

// ============================================================================
// Conversations (chat history - linked to tasks)
// ============================================================================

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  taskId: uuid('task_id').references(() => tasks.id),
  agentId: uuid('agent_id').references(() => agents.id),
  title: text('title'),
  status: text('status').default('active'), // 'active', 'completed', 'failed'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, {
    fields: [conversations.userId],
    references: [users.id],
  }),
  task: one(tasks, {
    fields: [conversations.taskId],
    references: [tasks.id],
  }),
  agent: one(agents, {
    fields: [conversations.agentId],
    references: [agents.id],
  }),
  messages: many(messages),
}));

// ============================================================================
// Messages (individual chat messages)
// ============================================================================

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id).notNull(),
  role: text('role').notNull(), // 'user', 'agent', 'system'
  content: text('content').notNull(),
  metadata: jsonb('metadata'), // For storing action details, screenshots refs, etc.
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

// ============================================================================
// Agent Tasks (running tasks)
// ============================================================================

export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  userId: uuid('user_id').references(() => users.id).notNull(),
  agentId: uuid('agent_id').references(() => agents.id).notNull(),
  sessionId: text('session_id').notNull(), // Desktop session ID
  status: text('status').default('pending'), // 'pending', 'running', 'completed', 'failed', 'cancelled'
  objective: text('objective').notNull(),
  currentUrl: text('current_url'), // Last browser URL for session restoration
  actionCount: integer('action_count').default(0),
  maxActions: integer('max_actions').default(50),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const agentTasksRelations = relations(agentTasks, ({ one }) => ({
  conversation: one(conversations, {
    fields: [agentTasks.conversationId],
    references: [conversations.id],
  }),
  user: one(users, {
    fields: [agentTasks.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [agentTasks.agentId],
    references: [agents.id],
  }),
}));

// ============================================================================
// Type exports
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

export type UserAgent = typeof userAgents.$inferSelect;
export type NewUserAgent = typeof userAgents.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

export type AgentVersion = typeof agentVersions.$inferSelect;
export type NewAgentVersion = typeof agentVersions.$inferInsert;

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

// ============================================================================
// Admin Users (users with admin privileges)
// ============================================================================

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const adminUsersRelations = relations(adminUsers, ({ one }) => ({
  user: one(users, {
    fields: [adminUsers.userId],
    references: [users.id],
  }),
}));

// ============================================================================
// System Settings (configurable settings like API keys, prompts)
// ============================================================================

export const systemSettings = pgTable('system_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  value: text('value'),
  description: text('description'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  updatedById: uuid('updated_by_id').references(() => users.id),
});

export const systemSettingsRelations = relations(systemSettings, ({ one }) => ({
  updatedBy: one(users, {
    fields: [systemSettings.updatedById],
    references: [users.id],
  }),
}));

export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;

export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;

// ============================================================================
// Invite Codes (user-to-user invitations)
// ============================================================================

export const inviteCodes = pgTable('invite_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(), // 8 alphanumeric characters, case sensitive
  createdByUserId: uuid('created_by_user_id').references(() => users.id).notNull(),
  usedByUserId: uuid('used_by_user_id').references(() => users.id),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inviteCodesRelations = relations(inviteCodes, ({ one }) => ({
  createdBy: one(users, {
    fields: [inviteCodes.createdByUserId],
    references: [users.id],
  }),
  usedBy: one(users, {
    fields: [inviteCodes.usedByUserId],
    references: [users.id],
  }),
}));

export type InviteCode = typeof inviteCodes.$inferSelect;
export type NewInviteCode = typeof inviteCodes.$inferInsert;

// ============================================================================
// Organizations (teams for collaboration)
// ============================================================================

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').unique(), // URL-friendly identifier
  ownerId: uuid('owner_id').references(() => users.id).notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, {
    fields: [organizations.ownerId],
    references: [users.id],
  }),
  members: many(organizationMembers),
  invites: many(organizationInvites),
  tasks: many(tasks),
}));

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

// ============================================================================
// Organization Members (team membership with roles)
// ============================================================================

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export const organizationMembers = pgTable('organization_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  role: text('role').$type<OrgRole>().notNull().default('member'),
  invitedById: uuid('invited_by_id').references(() => users.id),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
});

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
  invitedBy: one(users, {
    fields: [organizationMembers.invitedById],
    references: [users.id],
  }),
}));

export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;

// ============================================================================
// Organization Invites (pending invitations)
// ============================================================================

export const organizationInvites = pgTable('organization_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  email: text('email').notNull(),
  role: text('role').$type<OrgRole>().notNull().default('member'),
  token: text('token').notNull().unique(),
  invitedById: uuid('invited_by_id').references(() => users.id).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const organizationInvitesRelations = relations(organizationInvites, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationInvites.orgId],
    references: [organizations.id],
  }),
  invitedBy: one(users, {
    fields: [organizationInvites.invitedById],
    references: [users.id],
  }),
}));

// ============================================================================
// Servers (with direct team membership)
// ============================================================================

export type DeploymentType = 'local' | 'remote';
export type ServerStatusType = 'online' | 'offline' | 'suspended' | 'provisioning' | 'error';
export type ServerTier =
  // New descriptive tier IDs
  | 'shared-4x-1gb' | 'shared-4x-2gb' | 'shared-4x-4gb' | 'shared-4x-8gb'
  | 'shared-8x-4gb' | 'shared-8x-8gb' | 'shared-8x-16gb'
  | 'perf-2x-4gb' | 'perf-2x-8gb' | 'perf-2x-16gb'
  | 'perf-4x-8gb' | 'perf-4x-16gb' | 'perf-4x-32gb'
  // Legacy tier IDs (kept for existing DB rows)
  | 'shared-cpu-1x' | 'shared-cpu-2x' | 'shared-cpu-4x'
  | 'performance-cpu-2x' | 'performance-cpu-4x'
  | 'micro' | 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge';

export const servers = pgTable('servers', {
  id: text('id').primaryKey(), // Uses server ID format (e.g., ws_xxx)
  name: text('name').notNull(),
  ownerId: uuid('owner_id').references(() => users.id).notNull(),
  // Deployment type
  deploymentType: text('deployment_type').$type<DeploymentType>().default('local'),
  // Server registration fields
  tokenHash: text('token_hash'), // SHA-256 hash of the server token (plaintext shown once at creation)
  serverUrl: text('server_url'), // URL of the registered server
  status: text('status').$type<ServerStatusType>(), // 'online' | 'offline' | 'suspended' | 'provisioning' | 'error'
  lastSeen: timestamp('last_seen'), // Last heartbeat from server
  // Machine fields (for remote deployments)
  machineId: text('machine_id'), // Provider machine ID
  machineName: text('machine_name'), // Machine name
  region: text('region'), // Provider region (e.g., 'iad', 'fsn1')
  volumeId: text('volume_id'), // Provider volume ID for persistent storage
  provider: text('provider').$type<'fly'>().notNull().default('fly'), // Infrastructure provider
  tier: text('tier').$type<ServerTier>().default('shared-cpu-1x'), // Machine tier based on hardware specs
  iconUrl: text('icon_url'), // Custom server icon (base64 data URL)
  // Auto-suspend settings
  autoSuspendEnabled: boolean('auto_suspend_enabled').notNull().default(true), // If true, suspend when idle
  autoSuspendIdleMinutes: integer('auto_suspend_idle_minutes').default(15),
  idleSince: timestamp('idle_since'), // When server first started reporting idle (null = not idle)
  // Machine billing
  machineStartedAt: timestamp('machine_started_at'), // When the machine last started (for billing ticks)
  // Cloudflare Tunnel fields (for public port routing)
  tunnelId: text('tunnel_id'), // Cloudflare Named Tunnel ID
  tunnelToken: text('tunnel_token'), // Deprecated: no longer persisted in plaintext (kept for migration compatibility)
  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const serversRelations = relations(servers, ({ one, many }) => ({
  owner: one(users, {
    fields: [servers.ownerId],
    references: [users.id],
  }),
  members: many(serverMembers),
  invites: many(serverInvites),
  inviteLinks: many(serverInviteLinks),
  publicPorts: many(publicPorts),
}));

export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;

// ============================================================================
// Server Members (team membership with roles)
// ============================================================================

export type ServerRole = 'owner' | 'admin' | 'member' | 'viewer';

export const serverMembers = pgTable('server_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: text('server_id').references(() => servers.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  role: text('role').$type<ServerRole>().notNull().default('member'),
  invitedById: uuid('invited_by_id').references(() => users.id),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
  sortOrder: integer('sort_order'),
}, (t) => [
  unique('server_members_server_id_user_id_unique').on(t.serverId, t.userId),
]);

export const serverMembersRelations = relations(serverMembers, ({ one }) => ({
  server: one(servers, {
    fields: [serverMembers.serverId],
    references: [servers.id],
  }),
  user: one(users, {
    fields: [serverMembers.userId],
    references: [users.id],
  }),
  invitedBy: one(users, {
    fields: [serverMembers.invitedById],
    references: [users.id],
  }),
}));

export type ServerMember = typeof serverMembers.$inferSelect;
export type NewServerMember = typeof serverMembers.$inferInsert;

// ============================================================================
// Server Invites (pending invitations)
// ============================================================================

export const serverInvites = pgTable('server_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: text('server_id').references(() => servers.id).notNull(),
  email: text('email').notNull(),
  role: text('role').$type<ServerRole>().notNull().default('member'),
  token: text('token').notNull().unique(),
  invitedById: uuid('invited_by_id').references(() => users.id).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const serverInvitesRelations = relations(serverInvites, ({ one }) => ({
  server: one(servers, {
    fields: [serverInvites.serverId],
    references: [servers.id],
  }),
  invitedBy: one(users, {
    fields: [serverInvites.invitedById],
    references: [users.id],
  }),
}));

export type ServerInvite = typeof serverInvites.$inferSelect;
export type NewServerInvite = typeof serverInvites.$inferInsert;

// ============================================================================
// Server Invite Links (Discord-style shareable invite links)
// ============================================================================

export const serverInviteLinks = pgTable('server_invite_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: text('server_id').references(() => servers.id).notNull(),
  code: text('code').notNull().unique(),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const serverInviteLinksRelations = relations(serverInviteLinks, ({ one }) => ({
  server: one(servers, {
    fields: [serverInviteLinks.serverId],
    references: [servers.id],
  }),
  createdBy: one(users, {
    fields: [serverInviteLinks.createdById],
    references: [users.id],
  }),
}));

export type ServerInviteLink = typeof serverInviteLinks.$inferSelect;
export type NewServerInviteLink = typeof serverInviteLinks.$inferInsert;

// ============================================================================
// Server Bans
// ============================================================================

export const serverBans = pgTable('server_bans', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: text('server_id').references(() => servers.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  reason: text('reason'),
  bannedById: uuid('banned_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const serverBansRelations = relations(serverBans, ({ one }) => ({
  server: one(servers, {
    fields: [serverBans.serverId],
    references: [servers.id],
  }),
  user: one(users, {
    fields: [serverBans.userId],
    references: [users.id],
    relationName: 'bannedUser',
  }),
  bannedBy: one(users, {
    fields: [serverBans.bannedById],
    references: [users.id],
    relationName: 'bannedByUser',
  }),
}));

export type ServerBan = typeof serverBans.$inferSelect;
export type NewServerBan = typeof serverBans.$inferInsert;

// ============================================================================
// Public Ports (expose server services via custom subdomains)
// ============================================================================

export const publicPorts = pgTable('public_ports', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: text('server_id').references(() => servers.id).notNull(),
  subdomain: text('subdomain').notNull().unique(),
  port: integer('port').notNull(),
  label: text('label'),
  dnsRecordId: text('dns_record_id'), // Cloudflare DNS CNAME record ID
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const publicPortsRelations = relations(publicPorts, ({ one }) => ({
  server: one(servers, {
    fields: [publicPorts.serverId],
    references: [servers.id],
  }),
}));

export type PublicPort = typeof publicPorts.$inferSelect;
export type NewPublicPort = typeof publicPorts.$inferInsert;

// ============================================================================
// Server Templates (admin-designated template servers)
// ============================================================================

export const serverTemplates = pgTable('server_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: text('server_id').references(() => servers.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const serverTemplatesRelations = relations(serverTemplates, ({ one }) => ({
  server: one(servers, {
    fields: [serverTemplates.serverId],
    references: [servers.id],
  }),
}));

export type ServerTemplate = typeof serverTemplates.$inferSelect;
export type NewServerTemplate = typeof serverTemplates.$inferInsert;

// ============================================================================
// Device Auth Codes (for desktop app OAuth flow)
// ============================================================================

export const deviceCodes = pgTable('device_codes', {
  deviceCode: text('device_code').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  userId: uuid('user_id').references(() => users.id),
  expiresAt: timestamp('expires_at').notNull(),
  interval: integer('interval').notNull().default(5),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type DeviceCode = typeof deviceCodes.$inferSelect;
export type NewDeviceCode = typeof deviceCodes.$inferInsert;

// ============================================================================
// Password Reset Tokens
// ============================================================================

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  tokenHash: text('token_hash').notNull(), // SHA-256 hash of the token (plaintext sent in email)
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, {
    fields: [passwordResetTokens.userId],
    references: [users.id],
  }),
}));

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// ============================================================================
// Email Verification Tokens
// ============================================================================

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  tokenHash: text('token_hash').notNull(), // SHA-256 hash of the token (plaintext sent in email)
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const emailVerificationTokensRelations = relations(emailVerificationTokens, ({ one }) => ({
  user: one(users, {
    fields: [emailVerificationTokens.userId],
    references: [users.id],
  }),
}));

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;
