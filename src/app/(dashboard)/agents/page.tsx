import { auth } from '@/lib/auth';
import { db, agents, users } from '@/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

type AgentRow = Awaited<ReturnType<typeof getAgents>>[number];

async function getAgents() {
  return db
    .select({
      agent: agents,
      creator: users,
    })
    .from(agents)
    .leftJoin(users, eq(agents.createdById, users.id))
    .orderBy(agents.createdAt);
}

export default async function AgentsPage() {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.isAdmin) {
    redirect('/');
  }

  const allAgents = await getAgents();

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Agents</h1>

      <div className="bg-slate-800 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Description
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Public
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Created By
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {allAgents.map(({ agent, creator }: AgentRow) => (
              <tr key={agent.id} className="hover:bg-slate-750">
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className="text-white font-medium">{agent.name}</span>
                </td>
                <td className="px-6 py-4 text-slate-300 max-w-xs truncate">
                  {agent.description || '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {agent.isPublic ? (
                    <span className="px-2 py-1 text-xs font-medium bg-green-600 text-white rounded">
                      Public
                    </span>
                  ) : (
                    <span className="px-2 py-1 text-xs font-medium bg-slate-600 text-slate-300 rounded">
                      Private
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-slate-300">
                  {creator?.name || 'System'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-slate-400 text-sm">
                  {new Date(agent.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {allAgents.length === 0 && (
          <div className="px-6 py-8 text-center text-slate-400">
            No agents found
          </div>
        )}
      </div>
    </div>
  );
}
