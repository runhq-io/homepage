import { db, agents, users, agentTasks, measureQuery } from '@/db';
import { eq, desc, count } from 'drizzle-orm';

import { AgentsTable, type AdminAgentRow } from './AgentsTable';

export const dynamic = 'force-dynamic';

async function getAgents() {
  return measureQuery('getAgents', () =>
    db
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
        },
        creator: users,
      })
      .from(agents)
      .leftJoin(users, eq(agents.createdById, users.id))
      .orderBy(desc(agents.createdAt))
  );
}

async function getTaskCounts() {
  return measureQuery('getTaskCounts', async () => {
    const counts = await db
      .select({
        agentId: agentTasks.agentId,
        taskCount: count(),
      })
      .from(agentTasks)
      .groupBy(agentTasks.agentId);

    return counts.reduce((acc, { agentId, taskCount }) => {
      if (agentId) acc[agentId] = Number(taskCount);
      return acc;
    }, {} as Record<string, number>);
  });
}

export default async function AgentsPage() {
  const pageStart = performance.now();
  console.log('[AgentsPage] Starting page render...');

  const [allAgents, taskCounts] = await Promise.all([getAgents(), getTaskCounts()]);

  console.log(`[AgentsPage] Data fetched in ${(performance.now() - pageStart).toFixed(0)}ms`);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-white">Agents</h1>
        <span className="text-slate-400">{allAgents.length} total</span>
      </div>

	    <AgentsTable
	      rows={allAgents.map(({ agent, creator }) =>
	        ({
	          id: agent.id,
	          name: agent.name,
	          description: agent.description,
	          isPublic: Boolean(agent.isPublic),
	          taskCount: taskCounts[agent.id] || 0,
	          createdBy: creator?.name || creator?.email || 'System',
	          createdAt: agent.createdAt,
	        }) satisfies AdminAgentRow
	      )}
	    />
    </div>
  );
}
