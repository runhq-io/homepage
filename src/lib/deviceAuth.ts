// Device auth codes persisted to database (survives HMR and server restarts)
import { eq, lt } from 'drizzle-orm';
import { getDb, deviceCodes } from '@/db';

/**
 * Authorize a device code (called from the verification page)
 */
export async function authorizeDeviceCode(userCode: string, userId: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(deviceCodes)
    .set({ userId })
    .where(eq(deviceCodes.userCode, userCode))
    .returning();

  return result.length > 0;
}

/**
 * Get device code data by user code
 */
export async function getDeviceCodeByUserCode(userCode: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.userCode, userCode));

  if (rows.length === 0) return null;

  const row = rows[0];
  // Check if expired
  if (row.expiresAt < new Date()) {
    // Clean up expired code
    await db.delete(deviceCodes).where(eq(deviceCodes.userCode, userCode));
    return null;
  }

  return {
    userCode: row.userCode,
    userId: row.userId ?? undefined,
    expiresAt: row.expiresAt.getTime(),
    interval: row.interval,
  };
}

/**
 * Get device code data by device code
 */
export async function getDeviceCode(deviceCode: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCode, deviceCode));

  if (rows.length === 0) return null;

  const row = rows[0];
  // Check if expired
  if (row.expiresAt < new Date()) {
    // Clean up expired code
    await db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));
    return null;
  }

  return {
    userCode: row.userCode,
    userId: row.userId ?? undefined,
    expiresAt: row.expiresAt.getTime(),
    interval: row.interval,
  };
}

/**
 * Store a new device code
 */
export async function setDeviceCode(deviceCode: string, data: {
  userCode: string;
  userId?: string;
  expiresAt: number;
  interval: number;
}) {
  const db = getDb();
  await db.insert(deviceCodes).values({
    deviceCode,
    userCode: data.userCode,
    userId: data.userId ?? null,
    expiresAt: new Date(data.expiresAt),
    interval: data.interval,
  });
}

/**
 * Delete a device code
 */
export async function deleteDeviceCode(deviceCode: string) {
  const db = getDb();
  await db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));
}

/**
 * Clean up expired codes (can be called periodically or via cron)
 */
export async function cleanupExpiredCodes() {
  const db = getDb();
  await db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, new Date()));
}
