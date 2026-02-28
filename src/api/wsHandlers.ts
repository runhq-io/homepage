/**
 * WebSocket message handler registrations.
 * Extracted from api/src/index.ts — registers all 40+ message handlers.
 */
import type { FishtankWebSocketServer } from './WebSocketServer';
import type {
  GetAgentsMessage,
  CreateAgentMessage,
  UpdateAgentMessage,
  DeleteAgentMessage,
  AgentsListMessage,
  AgentCreatedMessage,
  AgentUpdatedMessage,
  AgentDeletedMessage,
  GetTasksMessage,
  CreateTaskMessage,
  UpdateTaskMessage,
  DeleteTaskMessage,
  GetTaskConversationMessage,
  TasksListMessage,
  TaskCreatedMessage,
  TaskUpdatedMessage,
  TaskDeletedMessage,
  TaskConversationMessage,
  GetOrgsMessage,
  CreateOrgMessage,
  UpdateOrgMessage,
  DeleteOrgMessage,
  GetOrgMembersMessage,
  InviteOrgMemberMessage,
  RemoveOrgMemberMessage,
  UpdateOrgMemberRoleMessage,
  LeaveOrgMessage,
  AcceptOrgInviteMessage,
  GetPendingInvitesMessage,
  ShareTaskWithOrgMessage,
  UnshareTaskMessage,
  GetOrgTasksMessage,
  OrgsListMessage,
  OrgCreatedMessage,
  OrgUpdatedMessage,
  OrgDeletedMessage,
  OrgMembersListMessage,
  OrgInviteSentMessage,
  OrgMemberRemovedMessage,
  OrgMemberRoleUpdatedMessage,
  OrgLeftMessage,
  OrgInviteAcceptedMessage,
  PendingInvitesListMessage,
  TaskSharedMessage,
  TaskUnsharedMessage,
  OrgTasksListMessage,
  SubscribeTaskViewMessage,
  UnsubscribeTaskViewMessage,
  TaskViewFrameMessage,
  TaskFileRequestMessage,
  TaskFileWriteMessage,
  TaskRemoteInputMessage,
  TaskViewSubscribedMessage,
  TaskViewUnsubscribedMessage,
  TaskViewFrameRelayMessage,
  TaskFileResponseMessage,
  TaskFileWriteResultMessage,
  TaskRemoteInputRelayMessage,
  TaskFileRequestRelayMessage,
  TaskFileWriteRelayMessage,
} from '@fishtank/server-protocol';
import * as AgentService from './services/AgentService';
import * as TaskService from './services/TaskService';
import * as OrganizationService from './services/OrganizationService';
import * as ServerService from './services/ServerService';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

export function registerWsHandlers(wsServer: FishtankWebSocketServer): void {
  // Handle get_agents request from desktop
  wsServer.onMessage('get_agents', async (client, message) => {
    const request = message as GetAgentsMessage;
    console.log(`[Agents] Get agents request from ${client.sessionId}`);

    try {
      const userId = client.userId || 'anonymous';
      const agents = await AgentService.getUserAgents(userId);

      const response: AgentsListMessage = {
        type: 'agents_list',
        agents,
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Agents] Failed to get agents:`, error);
    }
  });

  // Handle create_agent request from desktop
  wsServer.onMessage('create_agent', async (client, message) => {
    const request = message as CreateAgentMessage;
    console.log(`[Agents] Create agent request from ${client.sessionId}:`, request.name);

    try {
      const userId = client.userId || 'anonymous';
      const agent = await AgentService.createAgent(userId, {
        id: request.agentId,
        name: request.name,
        description: request.description,
        systemPrompt: request.systemPrompt,
        isPublic: request.isPublic,
      });

      const response: AgentCreatedMessage = {
        type: 'agent_created',
        agent,
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Agents] Failed to create agent:`, error);
    }
  });

  // Handle update_agent request from desktop
  wsServer.onMessage('update_agent', async (client, message) => {
    const request = message as UpdateAgentMessage;
    console.log(`[Agents] Update agent request from ${client.sessionId}:`, request.agentId);

    try {
      const userId = client.userId || 'anonymous';
      const agent = await AgentService.updateAgent(request.agentId, userId, {
        name: request.name,
        description: request.description,
        systemPrompt: request.systemPrompt,
        isPublic: request.isPublic,
      });

      if (agent) {
        const response: AgentUpdatedMessage = {
          type: 'agent_updated',
          agent,
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      }
    } catch (error) {
      console.error(`[Agents] Failed to update agent:`, error);
    }
  });

  // Handle delete_agent request from desktop
  wsServer.onMessage('delete_agent', async (client, message) => {
    const request = message as DeleteAgentMessage;
    console.log(`[Agents] Delete agent request from ${client.sessionId}:`, request.agentId);

    let success = false;
    let error: string | undefined;
    try {
      const userId = client.userId || 'anonymous';
      success = await AgentService.deleteAgent(request.agentId, userId);
      if (!success) {
        error = 'Not authorized to delete this agent';
      }
    } catch (err) {
      console.error(`[Agents] Failed to delete agent:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    // Always send response so client doesn't hang
    const response: AgentDeletedMessage = {
      type: 'agent_deleted',
      agentId: request.agentId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
    console.log(`[Agents] Agent ${request.agentId} deleted: ${success}${error ? ` (${error})` : ''}`);
  });


  // ============================================================================
  // Task handlers (work session tasks that use agent templates)
  // ============================================================================

  // Handle get_tasks request from desktop
  wsServer.onMessage('get_tasks', async (client, message) => {
    const request = message as GetTasksMessage;
    console.log(`[Tasks] Get tasks request from ${client.sessionId}`);

    try {
      const userId = client.userId || 'anonymous';
      const tasks = await TaskService.getUserWorkTasks(userId);

      const response: TasksListMessage = {
        type: 'tasks_list',
        tasks,
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Tasks] Failed to get tasks:`, error);
    }
  });

  // Handle create_task request from desktop
  wsServer.onMessage('create_task', async (client, message) => {
    const request = message as CreateTaskMessage;
    console.log(`[Tasks] Create task request from ${client.sessionId}:`, request.name);

    try {
      const userId = client.userId || 'anonymous';
      const task = await TaskService.createWorkTask(userId, {
        name: request.name,
        agentId: request.agentId,
        description: request.description,
      });

      const response: TaskCreatedMessage = {
        type: 'task_created',
        task,
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Tasks] Failed to create task:`, error);
    }
  });

  // Handle update_task request from desktop
  wsServer.onMessage('update_task', async (client, message) => {
    const request = message as UpdateTaskMessage;
    console.log(`[Tasks] Update task request from ${client.sessionId}:`, request.taskId);

    try {
      const userId = client.userId || 'anonymous';
      const task = await TaskService.updateWorkTask(request.taskId, userId, {
        name: request.name,
        description: request.description,
        status: request.status,
        browserState: request.browserState,
        lastObjective: request.lastObjective,
      });

      if (task) {
        const response: TaskUpdatedMessage = {
          type: 'task_updated',
          task,
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      }
    } catch (error) {
      console.error(`[Tasks] Failed to update task:`, error);
    }
  });

  // Handle delete_task request from desktop
  wsServer.onMessage('delete_task', async (client, message) => {
    const request = message as DeleteTaskMessage;
    console.log(`[Tasks] Delete task request from ${client.sessionId}:`, request.taskId);

    let success = false;
    let error: string | undefined;
    try {
      const userId = client.userId || 'anonymous';
      success = await TaskService.deleteWorkTask(request.taskId, userId);
      if (!success) {
        error = 'Not authorized to delete this task';
      }
    } catch (err) {
      console.error(`[Tasks] Failed to delete task:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: TaskDeletedMessage = {
      type: 'task_deleted',
      taskId: request.taskId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
    console.log(`[Tasks] Task ${request.taskId} deleted: ${success}${error ? ` (${error})` : ''}`);
  });

  // Handle get_task_conversation request from desktop
  wsServer.onMessage('get_task_conversation', async (client, message) => {
    const request = message as GetTaskConversationMessage;
    console.log(`[Tasks] Get task conversation request from ${client.sessionId}:`, request.taskId);

    try {
      const conversation = await TaskService.getWorkTaskConversation(request.taskId);

      const response: TaskConversationMessage = {
        type: 'task_conversation',
        taskId: request.taskId,
        conversationId: conversation.conversationId,
        messages: conversation.messages,
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Tasks] Failed to get task conversation:`, error);
    }
  });

  // ============================================================================
  // Organization handlers (team collaboration)
  // ============================================================================

  // Get user's organizations
  wsServer.onMessage('get_orgs', async (client, message) => {
    console.log(`[Orgs] Get orgs request from ${client.sessionId}`);

    try {
      const userId = client.userId || 'anonymous';
      const orgs = await OrganizationService.getUserOrganizations(userId);

      const response: OrgsListMessage = {
        type: 'orgs_list',
        orgs: orgs.map(org => ({
          id: org.id,
          name: org.name,
          slug: org.slug || undefined,
          ownerId: org.ownerId,
          avatarUrl: org.avatarUrl || undefined,
          role: org.role,
          createdAt: org.createdAt.toISOString(),
          updatedAt: org.updatedAt.toISOString(),
        })),
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Orgs] Failed to get orgs:`, error);
    }
  });

  // Create organization
  wsServer.onMessage('create_org', async (client, message) => {
    const request = message as CreateOrgMessage;
    console.log(`[Orgs] Create org request from ${client.sessionId}:`, request.name);

    try {
      const userId = client.userId || 'anonymous';
      const org = await OrganizationService.createOrganization(userId, {
        name: request.name,
        slug: request.slug,
      });

      const response: OrgCreatedMessage = {
        type: 'org_created',
        org: {
          id: org.id,
          name: org.name,
          slug: org.slug || undefined,
          ownerId: org.ownerId,
          avatarUrl: org.avatarUrl || undefined,
          role: 'owner',
          createdAt: org.createdAt.toISOString(),
          updatedAt: org.updatedAt.toISOString(),
        },
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Orgs] Failed to create org:`, error);
    }
  });

  // Update organization
  wsServer.onMessage('update_org', async (client, message) => {
    const request = message as UpdateOrgMessage;
    console.log(`[Orgs] Update org request from ${client.sessionId}:`, request.orgId);

    try {
      const userId = client.userId || 'anonymous';
      const org = await OrganizationService.updateOrganization(request.orgId, userId, {
        name: request.name,
        slug: request.slug,
        avatarUrl: request.avatarUrl,
      });

      if (org) {
        const userOrgs = await OrganizationService.getUserOrganizations(userId);
        const userOrg = userOrgs.find(o => o.id === org.id);

        const response: OrgUpdatedMessage = {
          type: 'org_updated',
          org: {
            id: org.id,
            name: org.name,
            slug: org.slug || undefined,
            ownerId: org.ownerId,
            avatarUrl: org.avatarUrl || undefined,
            role: userOrg?.role || 'member',
            createdAt: org.createdAt.toISOString(),
            updatedAt: org.updatedAt.toISOString(),
          },
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      }
    } catch (error) {
      console.error(`[Orgs] Failed to update org:`, error);
    }
  });

  // Delete organization
  wsServer.onMessage('delete_org', async (client, message) => {
    const request = message as DeleteOrgMessage;
    console.log(`[Orgs] Delete org request from ${client.sessionId}:`, request.orgId);

    let success = false;
    let error: string | undefined;
    try {
      const userId = client.userId || 'anonymous';
      success = await OrganizationService.deleteOrganization(request.orgId, userId);
      if (!success) {
        error = 'Not authorized to delete this organization';
      }
    } catch (err) {
      console.error(`[Orgs] Failed to delete org:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgDeletedMessage = {
      type: 'org_deleted',
      orgId: request.orgId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Get organization members
  wsServer.onMessage('get_org_members', async (client, message) => {
    const request = message as GetOrgMembersMessage;
    console.log(`[Orgs] Get org members request from ${client.sessionId}:`, request.orgId);

    try {
      const members = await OrganizationService.getOrganizationMembers(request.orgId);

      const response: OrgMembersListMessage = {
        type: 'org_members_list',
        orgId: request.orgId,
        members: members.map(m => ({
          user: m.user,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        })),
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Orgs] Failed to get org members:`, error);
    }
  });

  // Invite member to organization
  wsServer.onMessage('invite_org_member', async (client, message) => {
    const request = message as InviteOrgMemberMessage;
    console.log(`[Orgs] Invite member request from ${client.sessionId}:`, request.email);

    let success = false;
    let error: string | undefined;
    let expiresAt: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      const result = await OrganizationService.createInvite(
        request.orgId,
        userId,
        request.email,
        request.role
      );

      if (result) {
        success = true;
        expiresAt = result.expiresAt.toISOString();
      } else {
        error = 'Failed to create invite';
      }
    } catch (err) {
      console.error(`[Orgs] Failed to invite member:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgInviteSentMessage = {
      type: 'org_invite_sent',
      orgId: request.orgId,
      email: request.email,
      expiresAt: expiresAt || '',
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Remove member from organization
  wsServer.onMessage('remove_org_member', async (client, message) => {
    const request = message as RemoveOrgMemberMessage;
    console.log(`[Orgs] Remove member request from ${client.sessionId}:`, request.userId);

    let success = false;
    let error: string | undefined;

    try {
      const requesterId = client.userId || 'anonymous';
      success = await OrganizationService.removeMember(request.orgId, requesterId, request.userId);
      if (!success) {
        error = 'Not authorized to remove this member';
      }
    } catch (err) {
      console.error(`[Orgs] Failed to remove member:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgMemberRemovedMessage = {
      type: 'org_member_removed',
      orgId: request.orgId,
      userId: request.userId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Update member role
  wsServer.onMessage('update_org_member_role', async (client, message) => {
    const request = message as UpdateOrgMemberRoleMessage;
    console.log(`[Orgs] Update member role request from ${client.sessionId}:`, request.userId);

    let success = false;
    let error: string | undefined;

    try {
      const requesterId = client.userId || 'anonymous';
      success = await OrganizationService.updateMemberRole(
        request.orgId,
        requesterId,
        request.userId,
        request.role
      );
      if (!success) {
        error = 'Not authorized to update this member\'s role';
      }
    } catch (err) {
      console.error(`[Orgs] Failed to update member role:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgMemberRoleUpdatedMessage = {
      type: 'org_member_role_updated',
      orgId: request.orgId,
      userId: request.userId,
      role: request.role,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Leave organization
  wsServer.onMessage('leave_org', async (client, message) => {
    const request = message as LeaveOrgMessage;
    console.log(`[Orgs] Leave org request from ${client.sessionId}:`, request.orgId);

    let success = false;
    let error: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      success = await OrganizationService.leaveOrganization(request.orgId, userId);
      if (!success) {
        error = 'Cannot leave organization (owner must transfer ownership first)';
      }
    } catch (err) {
      console.error(`[Orgs] Failed to leave org:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgLeftMessage = {
      type: 'org_left',
      orgId: request.orgId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Accept organization invite
  wsServer.onMessage('accept_org_invite', async (client, message) => {
    const request = message as AcceptOrgInviteMessage;
    console.log(`[Orgs] Accept invite request from ${client.sessionId}`);

    let success = false;
    let error: string | undefined;
    let orgId: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      const result = await OrganizationService.acceptInvite(request.token, userId);
      success = result.success;
      error = result.error;
      orgId = result.orgId;
    } catch (err) {
      console.error(`[Orgs] Failed to accept invite:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgInviteAcceptedMessage = {
      type: 'org_invite_accepted',
      orgId: orgId || '',
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Get pending invites for user
  wsServer.onMessage('get_pending_invites', async (client, message) => {
    console.log(`[Orgs] Get pending invites request from ${client.sessionId}`);

    try {
      const userId = client.userId || 'anonymous';
      // Get user's email
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);

      if (user?.email) {
        const invites = await OrganizationService.getUserPendingInvites(user.email);

        const response: PendingInvitesListMessage = {
          type: 'pending_invites_list',
          invites: invites.map(i => ({
            token: i.token,
            orgName: i.orgName,
            role: i.role,
            expiresAt: i.expiresAt.toISOString(),
          })),
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      } else {
        const response: PendingInvitesListMessage = {
          type: 'pending_invites_list',
          invites: [],
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      }
    } catch (error) {
      console.error(`[Orgs] Failed to get pending invites:`, error);
    }
  });

  // Share task with organization
  wsServer.onMessage('share_task_with_org', async (client, message) => {
    const request = message as ShareTaskWithOrgMessage;
    console.log(`[Orgs] Share task request from ${client.sessionId}:`, request.taskId);

    let success = false;
    let error: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      success = await OrganizationService.shareTaskWithOrg(request.taskId, request.orgId, userId);
      if (!success) {
        error = 'Not authorized to share this task';
      }
    } catch (err) {
      console.error(`[Orgs] Failed to share task:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: TaskSharedMessage = {
      type: 'task_shared',
      taskId: request.taskId,
      orgId: request.orgId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Unshare task
  wsServer.onMessage('unshare_task', async (client, message) => {
    const request = message as UnshareTaskMessage;
    console.log(`[Orgs] Unshare task request from ${client.sessionId}:`, request.taskId);

    let success = false;
    let error: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      success = await OrganizationService.unshareTask(request.taskId, userId);
      if (!success) {
        error = 'Not authorized to unshare this task';
      }
    } catch (err) {
      console.error(`[Orgs] Failed to unshare task:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: TaskUnsharedMessage = {
      type: 'task_unshared',
      taskId: request.taskId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Get organization's shared tasks
  wsServer.onMessage('get_org_tasks', async (client, message) => {
    const request = message as GetOrgTasksMessage;
    console.log(`[Orgs] Get org tasks request from ${client.sessionId}:`, request.orgId);

    try {
      const userId = client.userId || 'anonymous';
      const orgTasks = await OrganizationService.getOrgTasks(request.orgId, userId);

      const response: OrgTasksListMessage = {
        type: 'org_tasks_list',
        orgId: request.orgId,
        tasks: orgTasks.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description || undefined,
          agentId: t.agentId,
          status: (t.status || 'idle') as 'idle' | 'working' | 'paused' | 'completed' | 'error',
          browserState: t.browserState || undefined,
          lastObjective: t.lastObjective || undefined,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
          lastActiveAt: t.lastActiveAt?.toISOString(),
        })),
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Orgs] Failed to get org tasks:`, error);
    }
  });

  // ============================================================================
  // Task Streaming handlers (real-time collaboration)
  // ============================================================================

  // Subscribe to view a task's real-time stream
  wsServer.onMessage('subscribe_task_view', async (client, message) => {
    const request = message as SubscribeTaskViewMessage;
    console.log(`[Streaming] Subscribe task view request from ${client.sessionId}:`, request.taskId);

    let success = false;
    let error: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      // Check if user has permission to view this task
      const canView = await OrganizationService.canViewTask(request.taskId, userId);

      if (canView) {
        wsServer.subscribeToTask(client.sessionId, request.taskId);
        success = true;
      } else {
        error = 'Not authorized to view this task';
      }
    } catch (err) {
      console.error(`[Streaming] Failed to subscribe to task:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: TaskViewSubscribedMessage = {
      type: 'task_view_subscribed',
      taskId: request.taskId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Unsubscribe from a task's stream
  wsServer.onMessage('unsubscribe_task_view', async (client, message) => {
    const request = message as UnsubscribeTaskViewMessage;
    console.log(`[Streaming] Unsubscribe task view request from ${client.sessionId}:`, request.taskId);

    wsServer.unsubscribeFromTask(client.sessionId, request.taskId);

    const response: TaskViewUnsubscribedMessage = {
      type: 'task_view_unsubscribed',
      taskId: request.taskId,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Relay task view frame from host to subscribers
  wsServer.onMessage('task_view_frame', async (client, message) => {
    const request = message as TaskViewFrameMessage;
    // Don't log frames to avoid spam
    // console.log(`[Streaming] Task view frame from ${client.sessionId}:`, request.taskId);

    try {
      const userId = client.userId || 'anonymous';

      // Register as host if not already
      if (!wsServer.getTaskHost(request.taskId)) {
        // Verify user owns this task
        const canParticipate = await OrganizationService.canParticipateInTask(request.taskId, userId);
        if (canParticipate) {
          wsServer.registerTaskHost(client.sessionId, request.taskId);
        }
      }

      // Relay to all subscribers
      const relayMessage: TaskViewFrameRelayMessage = {
        type: 'task_view_frame_relay',
        taskId: request.taskId,
        frameType: request.frameType,
        data: request.data,
        fromUserId: userId,
        timestamp: Date.now(),
      };
      wsServer.broadcastToTaskSubscribers(request.taskId, relayMessage, client.sessionId);
    } catch (error) {
      console.error(`[Streaming] Failed to relay task frame:`, error);
    }
  });

  // Handle file request from viewer - relay to host
  wsServer.onMessage('task_file_request', async (client, message) => {
    const request = message as TaskFileRequestMessage;
    console.log(`[Streaming] Task file request from ${client.sessionId}:`, request.path);

    try {
      const userId = client.userId || 'anonymous';
      const canView = await OrganizationService.canViewTask(request.taskId, userId);

      if (!canView) {
        const errorResponse: TaskFileResponseMessage = {
          type: 'task_file_response',
          taskId: request.taskId,
          path: request.path,
          error: 'Not authorized to view this task',
          timestamp: Date.now(),
        };
        wsServer.send(client, errorResponse);
        return;
      }

      // Find the host and relay the request
      const host = wsServer.getTaskHost(request.taskId);
      if (host) {
        // Relay using the proper CloudToDesktopMessage type
        const relayMessage: TaskFileRequestRelayMessage = {
          type: 'task_file_request_relay',
          taskId: request.taskId,
          path: request.path,
          requesterId: client.sessionId,
          timestamp: Date.now(),
        };
        wsServer.send(host, relayMessage);
      } else {
        const errorResponse: TaskFileResponseMessage = {
          type: 'task_file_response',
          taskId: request.taskId,
          path: request.path,
          error: 'Task host not connected',
          timestamp: Date.now(),
        };
        wsServer.send(client, errorResponse);
      }
    } catch (error) {
      console.error(`[Streaming] Failed to handle file request:`, error);
    }
  });

  // Handle file write from viewer - relay to host
  wsServer.onMessage('task_file_write', async (client, message) => {
    const request = message as TaskFileWriteMessage;
    console.log(`[Streaming] Task file write from ${client.sessionId}:`, request.path);

    try {
      const userId = client.userId || 'anonymous';
      const canParticipate = await OrganizationService.canParticipateInTask(request.taskId, userId);

      if (!canParticipate) {
        const errorResponse: TaskFileWriteResultMessage = {
          type: 'task_file_write_result',
          taskId: request.taskId,
          path: request.path,
          success: false,
          error: 'Not authorized to write to this task',
          timestamp: Date.now(),
        };
        wsServer.send(client, errorResponse);
        return;
      }

      // Find the host and relay the write request
      const host = wsServer.getTaskHost(request.taskId);
      if (host) {
        const relayMessage: TaskFileWriteRelayMessage = {
          type: 'task_file_write_relay',
          taskId: request.taskId,
          path: request.path,
          content: request.content,
          requesterId: client.sessionId,
          timestamp: Date.now(),
        };
        wsServer.send(host, relayMessage);
      } else {
        const errorResponse: TaskFileWriteResultMessage = {
          type: 'task_file_write_result',
          taskId: request.taskId,
          path: request.path,
          success: false,
          error: 'Task host not connected',
          timestamp: Date.now(),
        };
        wsServer.send(client, errorResponse);
      }
    } catch (error) {
      console.error(`[Streaming] Failed to handle file write:`, error);
    }
  });

  // Handle remote chat input - relay to host
  wsServer.onMessage('task_remote_input', async (client, message) => {
    const request = message as TaskRemoteInputMessage;
    console.log(`[Streaming] Task remote input from ${client.sessionId}`);

    try {
      const userId = client.userId || 'anonymous';
      const canParticipate = await OrganizationService.canParticipateInTask(request.taskId, userId);

      if (!canParticipate) {
        console.log(`[Streaming] User ${userId} not authorized to participate in task ${request.taskId}`);
        return;
      }

      // Get user name for display
      const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);

      // Find the host and relay the input
      const host = wsServer.getTaskHost(request.taskId);
      if (host) {
        const relayMessage: TaskRemoteInputRelayMessage = {
          type: 'task_remote_input_relay',
          taskId: request.taskId,
          input: request.input,
          fromUserId: userId,
          fromUserName: user?.name || user?.email || 'Team Member',
          timestamp: Date.now(),
        };
        wsServer.send(host, relayMessage);
      }
    } catch (error) {
      console.error(`[Streaming] Failed to handle remote input:`, error);
    }
  });

  // ============================================================================
  // Server handlers (direct team membership)
  // ============================================================================

  // Get user's servers
  wsServer.onMessage('get_workspaces', async (client, message) => {
    console.log(`[Servers] Get servers request from ${client.sessionId}`);

    try {
      const userId = client.userId || 'anonymous';
      const servers = await ServerService.getUserServers(userId);

      const response: OrgsListMessage = {
        type: 'orgs_list',
        orgs: servers.map(w => ({
          id: w.id,
          name: w.name,
          ownerId: w.ownerId,
          role: w.role,
          createdAt: w.createdAt.toISOString(),
          updatedAt: w.updatedAt.toISOString(),
        })),
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Servers] Failed to get servers:`, error);
    }
  });

  // Create server
  wsServer.onMessage('create_workspace', async (client, message) => {
    const request = message as CreateOrgMessage;
    console.log(`[Servers] Create server request from ${client.sessionId}:`, request.name);

    try {
      const userId = client.userId || 'anonymous';
      // Generate a server ID for cloud-created servers
      const serverId = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const server = await ServerService.createServer(userId, {
        id: serverId,
        name: request.name,
      });

      const response: OrgCreatedMessage = {
        type: 'org_created',
        org: {
          id: server.id,
          name: server.name,
          ownerId: server.ownerId,
          role: 'owner',
          createdAt: server.createdAt.toISOString(),
          updatedAt: server.updatedAt.toISOString(),
        },
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Servers] Failed to create server:`, error);
    }
  });

  // Update server
  wsServer.onMessage('update_workspace', async (client, message) => {
    const request = message as UpdateOrgMessage;
    console.log(`[Servers] Update server request from ${client.sessionId}:`, request.orgId);

    try {
      const userId = client.userId || 'anonymous';
      const server = await ServerService.updateServer(request.orgId, userId, {
        name: request.name,
      });

      if (server) {
        const userServers = await ServerService.getUserServers(userId);
        const userServer = userServers.find(w => w.id === server.id);

        const response: OrgUpdatedMessage = {
          type: 'org_updated',
          org: {
            id: server.id,
            name: server.name,
            ownerId: server.ownerId,
            role: userServer?.role || 'member',
            createdAt: server.createdAt.toISOString(),
            updatedAt: server.updatedAt.toISOString(),
          },
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      }
    } catch (error) {
      console.error(`[Servers] Failed to update server:`, error);
    }
  });

  // Delete server
  wsServer.onMessage('delete_workspace', async (client, message) => {
    const request = message as DeleteOrgMessage;
    console.log(`[Servers] Delete server request from ${client.sessionId}:`, request.orgId);

    let success = false;
    let error: string | undefined;
    try {
      const userId = client.userId || 'anonymous';
      const result = await ServerService.deleteServer(request.orgId, userId);
      success = result.success;
      if (!success) {
        error = result.error || 'Failed to delete server';
      }
    } catch (err) {
      console.error(`[Servers] Failed to delete server:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgDeletedMessage = {
      type: 'org_deleted',
      orgId: request.orgId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Get server members
  wsServer.onMessage('get_workspace_members', async (client, message) => {
    const request = message as GetOrgMembersMessage;
    console.log(`[Servers] Get server members request from ${client.sessionId}:`, request.orgId);

    try {
      const members = await ServerService.getServerMembers(request.orgId);

      const response: OrgMembersListMessage = {
        type: 'org_members_list',
        orgId: request.orgId,
        members: members.map(m => ({
          user: m.user,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        })),
        timestamp: Date.now(),
      };
      wsServer.send(client, response);
    } catch (error) {
      console.error(`[Servers] Failed to get server members:`, error);
    }
  });

  // Invite member to server
  wsServer.onMessage('invite_workspace_member', async (client, message) => {
    const request = message as InviteOrgMemberMessage;
    console.log(`[Servers] Invite member request from ${client.sessionId}:`, request.email);

    let success = false;
    let error: string | undefined;
    let expiresAt: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      const result = await ServerService.createInvite(
        request.orgId,
        userId,
        request.email,
        request.role
      );

      if (result) {
        success = true;
        expiresAt = result.expiresAt.toISOString();
      } else {
        error = 'Failed to create invite';
      }
    } catch (err) {
      console.error(`[Servers] Failed to invite member:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgInviteSentMessage = {
      type: 'org_invite_sent',
      orgId: request.orgId,
      email: request.email,
      expiresAt: expiresAt || '',
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Remove member from server
  wsServer.onMessage('remove_workspace_member', async (client, message) => {
    const request = message as RemoveOrgMemberMessage;
    console.log(`[Servers] Remove member request from ${client.sessionId}:`, request.userId);

    let success = false;
    let error: string | undefined;

    try {
      const requesterId = client.userId || 'anonymous';
      success = await ServerService.removeMember(request.orgId, requesterId, request.userId);
      if (!success) {
        error = 'Not authorized to remove this member';
      }
    } catch (err) {
      console.error(`[Servers] Failed to remove member:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgMemberRemovedMessage = {
      type: 'org_member_removed',
      orgId: request.orgId,
      userId: request.userId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Update member role
  wsServer.onMessage('update_workspace_member_role', async (client, message) => {
    const request = message as UpdateOrgMemberRoleMessage;
    console.log(`[Servers] Update member role request from ${client.sessionId}:`, request.userId);

    let success = false;
    let error: string | undefined;

    try {
      const requesterId = client.userId || 'anonymous';
      success = await ServerService.updateMemberRole(
        request.orgId,
        requesterId,
        request.userId,
        request.role
      );
      if (!success) {
        error = 'Not authorized to update this member\'s role';
      }
    } catch (err) {
      console.error(`[Servers] Failed to update member role:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgMemberRoleUpdatedMessage = {
      type: 'org_member_role_updated',
      orgId: request.orgId,
      userId: request.userId,
      role: request.role,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Leave server
  wsServer.onMessage('leave_workspace', async (client, message) => {
    const request = message as LeaveOrgMessage;
    console.log(`[Servers] Leave server request from ${client.sessionId}:`, request.orgId);

    let success = false;
    let error: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      success = await ServerService.leaveServer(request.orgId, userId);
      if (!success) {
        error = 'Cannot leave server (owner must transfer ownership first)';
      }
    } catch (err) {
      console.error(`[Servers] Failed to leave server:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgLeftMessage = {
      type: 'org_left',
      orgId: request.orgId,
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Accept server invite
  wsServer.onMessage('accept_workspace_invite', async (client, message) => {
    const request = message as AcceptOrgInviteMessage;
    console.log(`[Servers] Accept invite request from ${client.sessionId}`);

    let success = false;
    let error: string | undefined;
    let serverId: string | undefined;

    try {
      const userId = client.userId || 'anonymous';
      const result = await ServerService.acceptInvite(request.token, userId);
      success = result.success;
      error = result.error;
      serverId = result.serverId;
    } catch (err) {
      console.error(`[Servers] Failed to accept invite:`, err);
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const response: OrgInviteAcceptedMessage = {
      type: 'org_invite_accepted',
      orgId: serverId || '',
      success,
      error,
      timestamp: Date.now(),
    };
    wsServer.send(client, response);
  });

  // Get pending server invites for user
  wsServer.onMessage('get_pending_workspace_invites', async (client, message) => {
    console.log(`[Servers] Get pending invites request from ${client.sessionId}`);

    try {
      const userId = client.userId || 'anonymous';
      // Get user's email
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);

      if (user?.email) {
        const invites = await ServerService.getUserPendingInvites(user.email);

        const response: PendingInvitesListMessage = {
          type: 'pending_invites_list',
          invites: invites.map(i => ({
            token: i.token,
            orgName: i.serverName,
            role: i.role,
            expiresAt: i.expiresAt.toISOString(),
          })),
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      } else {
        const response: PendingInvitesListMessage = {
          type: 'pending_invites_list',
          invites: [],
          timestamp: Date.now(),
        };
        wsServer.send(client, response);
      }
    } catch (error) {
      console.error(`[Servers] Failed to get pending invites:`, error);
    }
  });
}
