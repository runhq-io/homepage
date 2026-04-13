import { db, agentTemplates } from '@/db';
import { AgentTemplatesManager } from './AgentTemplatesManager';

export const dynamic = 'force-dynamic';

async function getAgentTemplates() {
  const templates = await db
    .select({
      id: agentTemplates.id,
      name: agentTemplates.name,
      description: agentTemplates.description,
      systemPrompt: agentTemplates.systemPrompt,
      character: agentTemplates.character,
      enabledTools: agentTemplates.enabledTools,
      sortOrder: agentTemplates.sortOrder,
      createdAt: agentTemplates.createdAt,
    })
    .from(agentTemplates)
    .orderBy(agentTemplates.sortOrder);

  return templates;
}

export default async function AgentTemplatesPage() {
  const templates = await getAgentTemplates();

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-2">Agent Templates</h1>
      <p className="text-slate-400 mb-6">
        Global agent blueprints. Users see these as options when creating a new agent on their server.
      </p>
      <AgentTemplatesManager templates={templates as any} />
    </div>
  );
}
