import { db, users, agents, conversations, agentTasks } from '@/db';
import { count } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

async function getStats() {
  // Run all 4 count queries in parallel instead of sequentially
  // This reduces ~800ms (4 x 200ms) down to ~200ms (1 round trip)
  const [userCount, agentCount, conversationCount, taskCount] = await Promise.all([
    db.select({ count: count() }).from(users),
    db.select({ count: count() }).from(agents),
    db.select({ count: count() }).from(conversations),
    db.select({ count: count() }).from(agentTasks),
  ]);

  return {
    users: userCount[0].count,
    agents: agentCount[0].count,
    conversations: conversationCount[0].count,
    tasks: taskCount[0].count,
  };
}

export default async function AdminOverviewPage() {
  const stats = await getStats();

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Welcome!</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Total Users" value={stats.users} icon={<UsersIcon />} />
        <StatCard title="Total Agents" value={stats.agents} icon={<CpuIcon />} />
        <StatCard title="Conversations" value={stats.conversations} icon={<ChatIcon />} />
        <StatCard title="Tasks" value={stats.tasks} icon={<TaskIcon />} />
      </div>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="bg-slate-800 rounded-lg p-6">
      <div className="flex items-center gap-4">
        <div className="p-3 bg-slate-700 rounded-lg text-blue-400">{icon}</div>
        <div>
          <p className="text-sm text-slate-400">{title}</p>
          <p className="text-2xl font-bold text-white">{value}</p>
        </div>
      </div>
    </div>
  );
}

function UsersIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  );
}

function TaskIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  );
}
