import { db, users, subscriptions, plans, usageEvents, usageAdjustments, payments, adminUsers, measureQuery } from '@/db';
import { eq, sql, desc } from 'drizzle-orm';
import { UsersTable, type AdminUserRow } from './UsersTable';

export const dynamic = 'force-dynamic';

async function getUsersWithDetails() {
  return measureQuery('getUsersWithDetails', async () => {
    // Run all queries in parallel
		const [allUsers, allSubscriptions, allPlans, allUsage, allAdjustments, allPayments, allAdmins] = await Promise.all([
      db.select().from(users).orderBy(desc(users.createdAt)),
      db.select().from(subscriptions),
      db.select().from(plans),
      // Get total usage per user (sum of all usage events)
      db.select({
        userId: usageEvents.userId,
        totalUsageCents: sql<number>`sum(${usageEvents.costCents})::double precision`.as('total_usage_cents'),
      }).from(usageEvents).groupBy(usageEvents.userId),
      // Get total adjustments per user (sum of all admin adjustments)
      db.select({
        userId: usageAdjustments.userId,
        totalAdjustCents: sql<number>`sum(${usageAdjustments.amountCents})::double precision`.as('total_adjust_cents'),
      }).from(usageAdjustments).groupBy(usageAdjustments.userId),
      // Get total purchased per user (sum of successful payments)
      db.select({
        userId: payments.userId,
        totalPurchasedCents: sql<number>`sum(${payments.amountCents})`.as('total_purchased_cents'),
      }).from(payments).where(eq(payments.status, 'succeeded')).groupBy(payments.userId),
      db.select({ userId: adminUsers.userId }).from(adminUsers),
    ]);

    const adminUserIds = new Set(allAdmins.map((a) => a.userId));

    const subscriptionsByUser = new Map(allSubscriptions.map((s) => [s.userId, s]));
    const plansById = new Map(allPlans.map((p) => [p.id, p]));
    const usageByUser = new Map(allUsage.map((u) => [u.userId, u.totalUsageCents || 0]));
    const adjustByUser = new Map(allAdjustments.map((a) => [a.userId, a.totalAdjustCents || 0]));
    const purchasesByUser = new Map(allPayments.map((p) => [p.userId, p.totalPurchasedCents || 0]));

    return allUsers.map((user) => {
      const sub = subscriptionsByUser.get(user.id);
      const plan = sub ? plansById.get(sub.planId) : null;
      const totalUsageCents = (usageByUser.get(user.id) || 0) + (adjustByUser.get(user.id) || 0);
      const totalPurchasedCents = purchasesByUser.get(user.id) || 0;
      // subscriptions.creditBalanceCents is numeric(12,4) — Drizzle returns as string.
      const balanceCents = Number(sub?.creditBalanceCents ?? 0);

      return {
        ...user,
				isAdmin: adminUserIds.has(user.id),
        planName: plan?.name || 'free',
        balanceCents,
        totalUsageCents,
        totalPurchasedCents,
      };
    });
  });
}

export default async function UsersPage() {
	const allUsers = await getUsersWithDetails();

  return (
    <div>
	      <UsersTable
	        rows={allUsers.map(
	          (u) =>
	            ({
	              id: u.id,
	              name: u.name,
	              email: u.email,
	              avatarUrl: u.avatarUrl,
	              isActivated: u.isActivated ?? false,
	              planName: u.planName,
	              balanceCents: u.balanceCents,
	              totalUsageCents: u.totalUsageCents,
	              totalPurchasedCents: u.totalPurchasedCents,
	              isAdmin: Boolean(u.isAdmin),
	              lastLoginAt: u.lastLoginAt,
	              createdAt: u.createdAt,
	              authProvider: u.authProvider,
	            }) satisfies AdminUserRow
	        )}
	      />
    </div>
  );
}
