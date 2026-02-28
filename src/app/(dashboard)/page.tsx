import { auth } from '@/lib/auth';
import { db, conversations, agentTasks } from '@/db';
import { count, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

async function getUserStats(userId: string) {
  // Run both count queries in parallel instead of sequentially
  const [conversationResult, taskResult] = await Promise.all([
    db.select({ count: count() }).from(conversations).where(eq(conversations.userId, userId)),
    db.select({ count: count() }).from(agentTasks).where(eq(agentTasks.userId, userId)),
  ]);

  return {
    conversations: conversationResult[0].count,
    tasks: taskResult[0].count,
  };
}

export default async function DashboardPage() {
  const session = await auth();
  const user = session?.user as any;
  const stats = await getUserStats(user?.id);

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <StatCard title="My Conversations" value={stats.conversations} icon={<ChatIcon />} />
        <StatCard title="My Tasks" value={stats.tasks} icon={<TaskIcon />} />
      </div>

      <div className="bg-slate-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-2">Welcome, {user?.name}</h2>
        <p className="text-slate-400">
	          This is your Fishtank dashboard. View your conversations and agent activity here.
        </p>
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
