import { db, agents } from '@/db';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { MachineEditor } from '../MachineEditor';

export const dynamic = 'force-dynamic';

async function getAgent(id: string) {
  const result = await db
    .select({
      id: agents.id,
      name: agents.name,
      machineDefinition: agents.graphDefinition,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  return result[0] || null;
}

export default async function MachinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await getAgent(id);

  if (!agent) {
    notFound();
  }

  return (
    <div className="-m-8 flex flex-col h-screen w-[calc(100%+4rem)]">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-2 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/admin/agents/${agent.id}`} className="text-slate-400 hover:text-white">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <span className="text-sm font-medium text-white">{agent.name}</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-400">State Machine</span>
        </div>
        {agent.machineDefinition ? (
          <span className="text-xs text-green-400">Custom machine</span>
        ) : (
          <span className="text-xs text-slate-500">Using default machine</span>
        )}
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <MachineEditor
          agentId={agent.id}
          machineDefinition={agent.machineDefinition as Record<string, unknown> | null}
        />
      </div>
    </div>
  );
}
