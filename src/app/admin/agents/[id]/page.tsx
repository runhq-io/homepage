import { db, agents, users, agentTasks } from '@/db';
import { eq, desc, count } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AgentSettingsForm } from './AgentSettingsForm';

export const dynamic = 'force-dynamic';

async function getAgent(id: string) {
  const result = await db
    .select({
      agent: {
        id: agents.id,
        name: agents.name,
        description: agents.description,
        systemPrompt: agents.systemPrompt,
        isPublic: agents.isPublic,
        createdById: agents.createdById,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
        machineDefinition: agents.graphDefinition,
      },
      creator: users,
    })
    .from(agents)
    .leftJoin(users, eq(agents.createdById, users.id))
    .where(eq(agents.id, id))
    .limit(1);
  return result[0] || null;
}

async function getAgentStats(agentId: string) {
  const tasks = await db
    .select({ task: agentTasks })
    .from(agentTasks)
    .where(eq(agentTasks.agentId, agentId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(50);

  return {
    totalTasks: tasks.length,
    completed: tasks.filter(t => t.task.status === 'completed').length,
    failed: tasks.filter(t => t.task.status === 'failed').length,
    totalActions: tasks.reduce((sum, t) => sum + (t.task.actionCount || 0), 0),
    recentTasks: tasks.slice(0, 5),
  };
}

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getAgent(id);

  if (!data) {
    notFound();
  }

  const { agent, creator } = data;
  const stats = await getAgentStats(id);

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin/agents" className="text-slate-400 hover:text-white">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-white">{agent.name}</h1>
          <p className="text-sm text-slate-400">
            Created by {creator?.name || creator?.email || 'System'} on {new Date(agent.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="text-2xl font-bold text-white">{stats.totalTasks}</div>
          <div className="text-xs text-slate-400">Total Tasks</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="text-2xl font-bold text-green-400">{stats.completed}</div>
          <div className="text-xs text-slate-400">Completed</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="text-2xl font-bold text-red-400">{stats.failed}</div>
          <div className="text-xs text-slate-400">Failed</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="text-2xl font-bold text-blue-400">{stats.totalActions}</div>
          <div className="text-xs text-slate-400">Actions</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Settings Form */}
        <div className="col-span-2">
          <AgentSettingsForm
            agent={{
              id: agent.id,
              name: agent.name,
              description: agent.description || '',
              systemPrompt: agent.systemPrompt || '',
              isPublic: agent.isPublic || false,
            }}
          />
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* State Machine Link */}
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <h3 className="text-sm font-medium text-white mb-2">State Machine</h3>
            <p className="text-xs text-slate-400 mb-3">
              Configure how this agent transitions between states and what actions it takes.
            </p>
            <Link
              href={`/admin/agents/${agent.id}/machine`}
              className="block w-full px-4 py-2 text-sm text-center bg-blue-600 hover:bg-blue-500 text-white rounded font-medium transition-colors"
            >
              Edit State Machine
            </Link>
            {agent.machineDefinition && (
              <p className="text-[10px] text-green-400 mt-2 text-center">Custom machine configured</p>
            )}
          </div>

          {/* Recent Activity */}
          {stats.recentTasks.length > 0 && (
            <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
              <h3 className="text-sm font-medium text-white mb-3">Recent Tasks</h3>
              <div className="space-y-2">
                {stats.recentTasks.map(({ task }) => (
                  <div key={task.id} className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 truncate max-w-[150px]">{task.objective}</span>
                    <span className={
                      task.status === 'completed' ? 'text-green-400' :
                      task.status === 'failed' ? 'text-red-400' :
                      task.status === 'running' ? 'text-blue-400' :
                      'text-slate-400'
                    }>
                      {task.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Danger Zone */}
          <div className="bg-slate-800 rounded-lg p-4 border border-red-900/50">
            <h3 className="text-sm font-medium text-red-400 mb-2">Danger Zone</h3>
            <button className="w-full px-4 py-2 text-sm text-red-400 border border-red-900 hover:bg-red-900/20 rounded transition-colors">
              Delete Agent
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
