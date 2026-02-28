/**
 * Invite Code Service
 *
 * Handles invite code generation, validation, and usage.
 * Each user gets 5 invite codes when they're activated.
 */

import { db } from '../../db/index';
import { inviteCodes, users } from '../../db/schema';
import { eq } from 'drizzle-orm';

const CODES_PER_USER = 5;
const CODE_LENGTH = 8;
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a random invite code (8 alphanumeric characters, case sensitive)
 */
function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return code;
}

/**
 * Generate invite codes for a user (called when user is activated)
 */
export async function generateCodesForUser(userId: string, count: number = CODES_PER_USER): Promise<string[]> {
  const codes: string[] = [];

  for (let i = 0; i < count; i++) {
    // Generate unique code (retry if collision)
    let code: string;
    let attempts = 0;
    do {
      code = generateCode();
      const existing = await db
        .select()
        .from(inviteCodes)
        .where(eq(inviteCodes.code, code))
        .limit(1);
      if (existing.length === 0) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      console.error('[InviteService] Failed to generate unique code after 10 attempts');
      continue;
    }

    await db.insert(inviteCodes).values({
      code,
      createdByUserId: userId,
    });

    codes.push(code);
  }

  console.log(`[InviteService] Generated ${codes.length} invite codes for user ${userId}`);
  return codes;
}

/**
 * Get all invite codes for a user
 */
export async function getUserInviteCodes(userId: string): Promise<Array<{
  code: string;
  used: boolean;
  usedByEmail?: string;
  usedAt?: string;
}>> {
  const codes = await db
    .select({
      code: inviteCodes.code,
      usedByUserId: inviteCodes.usedByUserId,
      usedAt: inviteCodes.usedAt,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.createdByUserId, userId));

  // Get emails for used codes
  const result = await Promise.all(
    codes.map(async (c) => {
      let usedByEmail: string | undefined;
      if (c.usedByUserId) {
        const usedByUser = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, c.usedByUserId))
          .limit(1);
        usedByEmail = usedByUser[0]?.email || undefined;
      }
      return {
        code: c.code,
        used: !!c.usedByUserId,
        usedByEmail,
        usedAt: c.usedAt?.toISOString(),
      };
    })
  );

  return result;
}

/**
 * Validate and use an invite code
 * Returns the activated user ID if successful, null if failed
 */
export async function useInviteCode(code: string, userId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  // Check if user is already activated
  const user = await db
    .select({ isActivated: users.isActivated })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user[0]) {
    return { success: false, error: 'User not found' };
  }

  if (user[0].isActivated) {
    return { success: false, error: 'Account already activated' };
  }

  // Find the invite code
  const inviteCode = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);

  if (!inviteCode[0]) {
    return { success: false, error: 'Invalid invite code' };
  }

  if (inviteCode[0].usedByUserId) {
    return { success: false, error: 'Invite code already used' };
  }

  // Mark code as used
  await db
    .update(inviteCodes)
    .set({
      usedByUserId: userId,
      usedAt: new Date(),
    })
    .where(eq(inviteCodes.id, inviteCode[0].id));

  // Activate the user
  await db
    .update(users)
    .set({
      isActivated: true,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  // Generate invite codes for the newly activated user
  await generateCodesForUser(userId);

  console.log(`[InviteService] User ${userId} activated with code ${code}`);
  return { success: true };
}

/**
 * Check if a user is activated
 */
export async function isUserActivated(userId: string): Promise<boolean> {
  const user = await db
    .select({ isActivated: users.isActivated })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user[0]?.isActivated ?? false;
}

/**
 * Activate a user (admin only) - bypasses invite code requirement
 */
export async function activateUser(userId: string): Promise<boolean> {
  const user = await db
    .select({ isActivated: users.isActivated })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user[0]) {
    return false;
  }

  if (user[0].isActivated) {
    return true; // Already activated
  }

  // Activate the user
  await db
    .update(users)
    .set({
      isActivated: true,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  // Generate invite codes
  await generateCodesForUser(userId);

  console.log(`[InviteService] Admin activated user ${userId}`);
  return true;
}

/**
 * Admin: Generate additional invite codes for a user
 */
export async function adminGenerateCodes(userId: string, count: number): Promise<string[]> {
  return generateCodesForUser(userId, count);
}
