/**
 * Organization Service
 *
 * Handles team/organization management for collaboration features.
 * - Create/update/delete organizations
 * - Manage members and roles
 * - Handle invitations
 */

import { db } from '../../db/index';
import {
  organizations,
  organizationMembers,
  organizationInvites,
  users,
  tasks,
  type Organization,
  type OrganizationMember,
  type OrgRole,
} from '../../db/schema';
import { eq, and, or, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';

// ============================================================================
// Organization CRUD
// ============================================================================

/**
 * Create a new organization
 */
export async function createOrganization(
  ownerId: string,
  data: { name: string; slug?: string }
): Promise<Organization> {
  const slug = data.slug || generateSlug(data.name);

  const [org] = await db
    .insert(organizations)
    .values({
      name: data.name,
      slug,
      ownerId,
    })
    .returning();

  // Add owner as a member with 'owner' role
  await db.insert(organizationMembers).values({
    orgId: org.id,
    userId: ownerId,
    role: 'owner',
  });

  console.log(`[OrganizationService] Created org ${org.id} for user ${ownerId}`);
  return org;
}

/**
 * Get organization by ID
 */
export async function getOrganization(orgId: string): Promise<Organization | null> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return org || null;
}

/**
 * Get all organizations a user is a member of
 */
export async function getUserOrganizations(userId: string): Promise<Array<Organization & { role: OrgRole }>> {
  const memberships = await db
    .select({
      org: organizations,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(eq(organizationMembers.userId, userId));

  return memberships.map((m) => ({
    ...m.org,
    role: m.role,
  }));
}

/**
 * Update organization
 */
export async function updateOrganization(
  orgId: string,
  userId: string,
  data: { name?: string; slug?: string; avatarUrl?: string }
): Promise<Organization | null> {
  // Check if user has permission (owner or admin)
  const hasPermission = await checkOrgPermission(orgId, userId, ['owner', 'admin']);
  if (!hasPermission) {
    return null;
  }

  const [updated] = await db
    .update(organizations)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId))
    .returning();

  return updated || null;
}

/**
 * Delete organization (owner only)
 */
export async function deleteOrganization(orgId: string, userId: string): Promise<boolean> {
  const hasPermission = await checkOrgPermission(orgId, userId, ['owner']);
  if (!hasPermission) {
    return false;
  }

  // Delete members first (foreign key constraint)
  await db.delete(organizationMembers).where(eq(organizationMembers.orgId, orgId));

  // Delete invites
  await db.delete(organizationInvites).where(eq(organizationInvites.orgId, orgId));

  // Unlink tasks (don't delete, just remove org association)
  await db.update(tasks).set({ orgId: null }).where(eq(tasks.orgId, orgId));

  // Delete organization
  await db.delete(organizations).where(eq(organizations.id, orgId));

  console.log(`[OrganizationService] Deleted org ${orgId}`);
  return true;
}

// ============================================================================
// Member Management
// ============================================================================

/**
 * Get all members of an organization
 */
export async function getOrganizationMembers(
  orgId: string
): Promise<Array<{ user: { id: string; email: string | null; name: string | null; avatarUrl: string | null }; role: OrgRole; joinedAt: Date }>> {
  const members = await db
    .select({
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      joinedAt: organizationMembers.joinedAt,
      userEmail: users.email,
      userName: users.name,
      userAvatar: users.avatarUrl,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.orgId, orgId));

  return members.map((m) => ({
    user: {
      id: m.userId,
      email: m.userEmail,
      name: m.userName,
      avatarUrl: m.userAvatar,
    },
    role: m.role,
    joinedAt: m.joinedAt,
  }));
}

/**
 * Update member role
 */
export async function updateMemberRole(
  orgId: string,
  requesterId: string,
  targetUserId: string,
  newRole: OrgRole
): Promise<boolean> {
  // Only owner can change roles
  const hasPermission = await checkOrgPermission(orgId, requesterId, ['owner']);
  if (!hasPermission) {
    return false;
  }

  // Can't change owner's role
  const org = await getOrganization(orgId);
  if (org?.ownerId === targetUserId && newRole !== 'owner') {
    return false;
  }

  await db
    .update(organizationMembers)
    .set({ role: newRole })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)));

  return true;
}

/**
 * Remove member from organization
 */
export async function removeMember(orgId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  // Owner or admin can remove members
  const hasPermission = await checkOrgPermission(orgId, requesterId, ['owner', 'admin']);
  if (!hasPermission) {
    return false;
  }

  // Can't remove owner
  const org = await getOrganization(orgId);
  if (org?.ownerId === targetUserId) {
    return false;
  }

  // Admin can't remove other admins
  const requesterRole = await getMemberRole(orgId, requesterId);
  const targetRole = await getMemberRole(orgId, targetUserId);
  if (requesterRole === 'admin' && targetRole === 'admin') {
    return false;
  }

  await db
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)));

  console.log(`[OrganizationService] Removed user ${targetUserId} from org ${orgId}`);
  return true;
}

/**
 * Leave organization (self-removal)
 */
export async function leaveOrganization(orgId: string, userId: string): Promise<boolean> {
  // Owner can't leave (must transfer ownership first)
  const org = await getOrganization(orgId);
  if (org?.ownerId === userId) {
    return false;
  }

  await db
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));

  console.log(`[OrganizationService] User ${userId} left org ${orgId}`);
  return true;
}

// ============================================================================
// Invitations
// ============================================================================

const INVITE_EXPIRY_DAYS = 7;

/**
 * Create an invitation to join the organization
 */
export async function createInvite(
  orgId: string,
  inviterId: string,
  email: string,
  role: OrgRole = 'member'
): Promise<{ token: string; expiresAt: Date } | null> {
  // Check permission (owner or admin)
  const hasPermission = await checkOrgPermission(orgId, inviterId, ['owner', 'admin']);
  if (!hasPermission) {
    return null;
  }

  // Check if user is already a member
  const existingMember = await db
    .select()
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(and(eq(organizationMembers.orgId, orgId), eq(users.email, email)))
    .limit(1);

  if (existingMember.length > 0) {
    console.log(`[OrganizationService] User ${email} is already a member of org ${orgId}`);
    return null;
  }

  // Check for existing pending invite
  const existingInvite = await db
    .select()
    .from(organizationInvites)
    .where(and(eq(organizationInvites.orgId, orgId), eq(organizationInvites.email, email), isNull(organizationInvites.usedAt)))
    .limit(1);

  if (existingInvite.length > 0) {
    // Return existing invite token
    return {
      token: existingInvite[0].token,
      expiresAt: existingInvite[0].expiresAt,
    };
  }

  const token = nanoid(32);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(organizationInvites).values({
    orgId,
    email,
    role,
    token,
    invitedById: inviterId,
    expiresAt,
  });

  console.log(`[OrganizationService] Created invite for ${email} to org ${orgId}`);
  return { token, expiresAt };
}

/**
 * Get pending invites for an organization
 */
export async function getOrgInvites(
  orgId: string
): Promise<Array<{ email: string; role: OrgRole; expiresAt: Date; createdAt: Date }>> {
  const invites = await db
    .select({
      email: organizationInvites.email,
      role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt,
      createdAt: organizationInvites.createdAt,
    })
    .from(organizationInvites)
    .where(and(eq(organizationInvites.orgId, orgId), isNull(organizationInvites.usedAt)));

  return invites;
}

/**
 * Accept an invitation
 */
export async function acceptInvite(token: string, userId: string): Promise<{ success: boolean; orgId?: string; error?: string }> {
  const [invite] = await db
    .select()
    .from(organizationInvites)
    .where(eq(organizationInvites.token, token))
    .limit(1);

  if (!invite) {
    return { success: false, error: 'Invalid invite token' };
  }

  if (invite.usedAt) {
    return { success: false, error: 'Invite already used' };
  }

  if (invite.expiresAt < new Date()) {
    return { success: false, error: 'Invite expired' };
  }

  // Verify user email matches invite
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);

  if (!user || user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return { success: false, error: 'Email does not match invite' };
  }

  // Check if already a member
  const existingMember = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, invite.orgId), eq(organizationMembers.userId, userId)))
    .limit(1);

  if (existingMember.length > 0) {
    return { success: false, error: 'Already a member of this organization' };
  }

  // Add as member
  await db.insert(organizationMembers).values({
    orgId: invite.orgId,
    userId,
    role: invite.role,
    invitedById: invite.invitedById,
  });

  // Mark invite as used
  await db.update(organizationInvites).set({ usedAt: new Date() }).where(eq(organizationInvites.id, invite.id));

  console.log(`[OrganizationService] User ${userId} accepted invite to org ${invite.orgId}`);
  return { success: true, orgId: invite.orgId };
}

/**
 * Cancel/revoke an invitation
 */
export async function cancelInvite(orgId: string, requesterId: string, email: string): Promise<boolean> {
  const hasPermission = await checkOrgPermission(orgId, requesterId, ['owner', 'admin']);
  if (!hasPermission) {
    return false;
  }

  await db
    .delete(organizationInvites)
    .where(and(eq(organizationInvites.orgId, orgId), eq(organizationInvites.email, email), isNull(organizationInvites.usedAt)));

  return true;
}

/**
 * Get pending invites for a user (by email)
 */
export async function getUserPendingInvites(
  email: string
): Promise<Array<{ token: string; orgName: string; role: OrgRole; expiresAt: Date }>> {
  const invites = await db
    .select({
      token: organizationInvites.token,
      role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt,
      orgName: organizations.name,
    })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizationInvites.orgId, organizations.id))
    .where(and(eq(organizationInvites.email, email.toLowerCase()), isNull(organizationInvites.usedAt)));

  return invites.filter((i) => i.expiresAt > new Date());
}

// ============================================================================
// Task Sharing
// ============================================================================

/**
 * Share a task with an organization
 */
export async function shareTaskWithOrg(taskId: string, orgId: string, userId: string): Promise<boolean> {
  // Verify user owns the task
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  if (!task || task.userId !== userId) {
    return false;
  }

  // Verify user is a member of the org
  const isMember = await checkOrgPermission(orgId, userId, ['owner', 'admin', 'member']);
  if (!isMember) {
    return false;
  }

  await db.update(tasks).set({ orgId }).where(eq(tasks.id, taskId));

  console.log(`[OrganizationService] Task ${taskId} shared with org ${orgId}`);
  return true;
}

/**
 * Unshare a task (make it personal again)
 */
export async function unshareTask(taskId: string, userId: string): Promise<boolean> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  if (!task || task.userId !== userId) {
    return false;
  }

  await db.update(tasks).set({ orgId: null }).where(eq(tasks.id, taskId));

  console.log(`[OrganizationService] Task ${taskId} unshared`);
  return true;
}

/**
 * Get tasks shared with an organization
 */
export async function getOrgTasks(orgId: string, userId: string): Promise<typeof tasks.$inferSelect[]> {
  // Verify user is a member
  const isMember = await checkOrgPermission(orgId, userId, ['owner', 'admin', 'member', 'viewer']);
  if (!isMember) {
    return [];
  }

  const orgTasks = await db.select().from(tasks).where(eq(tasks.orgId, orgId));

  return orgTasks;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if user has required permission in org
 */
async function checkOrgPermission(orgId: string, userId: string, allowedRoles: OrgRole[]): Promise<boolean> {
  const [membership] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);

  return membership ? allowedRoles.includes(membership.role) : false;
}

/**
 * Get member's role in org
 */
async function getMemberRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const [membership] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);

  return membership?.role || null;
}

/**
 * Generate URL-friendly slug from name
 */
function generateSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + `-${nanoid(6)}`
  );
}

/**
 * Check if user can view a task (owner or org member)
 */
export async function canViewTask(taskId: string, userId: string): Promise<boolean> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  if (!task) return false;
  if (task.userId === userId) return true;
  if (task.orgId) {
    return checkOrgPermission(task.orgId, userId, ['owner', 'admin', 'member', 'viewer']);
  }
  return false;
}

/**
 * Check if user can participate in a task (owner or org member with write access)
 */
export async function canParticipateInTask(taskId: string, userId: string): Promise<boolean> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  if (!task) return false;
  if (task.userId === userId) return true;
  if (task.orgId) {
    return checkOrgPermission(task.orgId, userId, ['owner', 'admin', 'member']);
  }
  return false;
}
