import { auth } from '@/lib/auth';
import { db, users, userAgents, agents, conversations, agentTasks } from '@/db';
import { eq } from 'drizzle-orm';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

async function getUser(id: string) {
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0] || null;
}

async function getUserAgents(userId: string) {
  const result = await db
    .select({
      userAgent: userAgents,
      agent: agents,
    })
    .from(userAgents)
    .innerJoin(agents, eq(userAgents.agentId, agents.id))
    .where(eq(userAgents.userId, userId));

  return result;
}

async function getUserConversations(userId: string) {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(conversations.createdAt);
}

async function getUserTasks(userId: string) {
  return db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.userId, userId))
    .orderBy(agentTasks.createdAt);
}

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const currentUser = session?.user as any;

  if (!currentUser?.isAdmin) {
    redirect('/');
  }

  const { id } = await params;
  const user = await getUser(id);

  if (!user) {
    notFound();
  }

  const [userAgentsList, conversationsList, tasksList] = await Promise.all([
    getUserAgents(id),
    getUserConversations(id),
    getUserTasks(id),
  ]);

  return (
    <div>
      <Link href="/users" className="text-blue-400 hover:text-blue-300 mb-4 inline-block">
        &larr; Back to Users
      </Link>

      <div className="bg-slate-800 rounded-lg p-6 mb-8">
        <div className="flex items-center gap-4">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-16 w-16 rounded-full" />
          ) : (
            <div className="h-16 w-16 rounded-full bg-slate-600 flex items-center justify-center text-2xl text-slate-300">
              {user.name?.charAt(0) || '?'}
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-white">{user.name || 'Unknown'}</h1>
            <p className="text-slate-400">{user.email}</p>
            <p className="text-sm text-slate-500 mt-1">
              Joined {new Date(user.createdAt).toLocaleDateString()} via {user.authProvider}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <h2 className="text-lg font-semibold text-white mb-4">
            Agents ({userAgentsList.length})
          </h2>
          <div className="bg-slate-800 rounded-lg overflow-hidden">
            {userAgentsList.length > 0 ? (
              <ul className="divide-y divide-slate-700">
                {userAgentsList.map(({ userAgent, agent }) => (
                  <li key={userAgent.id} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-medium">
                          {userAgent.nickname || agent.name}
                        </p>
                        <p className="text-sm text-slate-400">{agent.description}</p>
                      </div>
                      {userAgent.isFavorite && (
                        <span className="text-yellow-400">★</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-slate-400">No agents</p>
            )}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white mb-4">
            Recent Tasks ({tasksList.length})
          </h2>
          <div className="bg-slate-800 rounded-lg overflow-hidden">
            {tasksList.length > 0 ? (
              <ul className="divide-y divide-slate-700">
                {tasksList.slice(0, 10).map((task) => (
                  <li key={task.id} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-white truncate">{task.objective}</p>
                        <p className="text-sm text-slate-400">
                          {task.actionCount} actions
                        </p>
                      </div>
                      <StatusBadge status={task.status || 'pending'} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-slate-400">No tasks</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-600',
    running: 'bg-blue-600',
    completed: 'bg-green-600',
    failed: 'bg-red-600',
  };

  return (
    <span
      className={`px-2 py-1 text-xs font-medium rounded ${colors[status] || 'bg-slate-600'} text-white`}
    >
      {status}
    </span>
  );
}
