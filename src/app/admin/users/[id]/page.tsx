import { db, users, userAgents, agents, subscriptions, plans, usageRecords, inviteCodes } from '@/db';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { SubscriptionManager } from './SubscriptionManager';
import { AgentsList } from './AgentsList';
import { InviteCodesManager } from './InviteCodesManager';

export const dynamic = 'force-dynamic';

async function getUser(id: string) {
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0] || null;
}

async function getUserSubscription(userId: string) {
  const result = await db
    .select({ subscription: subscriptions, plan: plans })
    .from(subscriptions)
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return result[0] || null;
}

async function getAllPlans() {
  return db.select().from(plans).where(eq(plans.isActive, true));
}

async function getCurrentPeriodUsage(userId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const result = await db
    .select()
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.userId, userId),
        gte(usageRecords.periodStart, startOfMonth),
        lte(usageRecords.periodEnd, endOfMonth)
      )
    )
    .limit(1);
  return result[0] || null;
}

async function getUserAgents(userId: string) {
  return db
    .select({ userAgent: userAgents, agent: agents })
    .from(userAgents)
    .innerJoin(agents, eq(userAgents.agentId, agents.id))
    .where(eq(userAgents.userId, userId));
}

async function getUserInviteCodes(userId: string) {
  return db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.createdByUserId, userId))
    .orderBy(desc(inviteCodes.createdAt));
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser(id);

  if (!user) {
    notFound();
  }

  const [userAgentsList, subscriptionData, allPlans, currentUsage, userInviteCodes] = await Promise.all([
    getUserAgents(id),
    getUserSubscription(id),
    getAllPlans(),
    getCurrentPeriodUsage(id),
    getUserInviteCodes(id),
  ]);

  return (
    <div className="max-w-5xl w-full overflow-x-hidden">
      <Link href="/admin/users" className="text-blue-400 hover:text-blue-300 text-sm mb-3 inline-block">
        ← Back
      </Link>

      {/* User Info Header - Compact */}
      <div className="flex items-center gap-3 mb-6">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-12 w-12 rounded-full flex-shrink-0" />
        ) : (
          <div className="h-12 w-12 rounded-full bg-slate-700 flex items-center justify-center text-xl text-slate-300 flex-shrink-0">
            {user.name?.charAt(0) || '?'}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white truncate">{user.name || 'Unknown'}</h1>
          <p className="text-slate-400 text-sm truncate">{user.email} · {user.authProvider} · {new Date(user.createdAt).toLocaleDateString()}</p>
        </div>
      </div>

      {/* Subscription & Usage - Compact */}
      <div className="bg-slate-800 rounded-lg p-4 mb-6">
        <SubscriptionManager
          userId={id}
          subscription={subscriptionData?.subscription || null}
          plan={subscriptionData?.plan || null}
          allPlans={allPlans}
          currentUsage={currentUsage}
        />
      </div>

      {/* Invite Codes */}
      <div className="bg-slate-800 rounded-lg p-4 mb-6">
        <InviteCodesManager userId={id} inviteCodes={userInviteCodes} />
      </div>

      {/* Agents with expandable prompts */}
      <div className="bg-slate-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">
          Agents ({userAgentsList.length})
        </h2>
        <AgentsList
          agents={userAgentsList.map(({ userAgent, agent }) => ({
            id: agent.id,
            name: userAgent.nickname || agent.name,
            description: agent.description,
            systemPrompt: agent.systemPrompt,
            isFavorite: userAgent.isFavorite || false,
          }))}
        />
      </div>
    </div>
  );
}
