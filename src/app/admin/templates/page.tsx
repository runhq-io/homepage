import { db, serverTemplates, servers } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { TemplatesManager } from './TemplatesManager';

export const dynamic = 'force-dynamic';

async function getTemplates() {
  const templates = await db
    .select({
      id: serverTemplates.id,
      serverId: serverTemplates.serverId,
      name: serverTemplates.name,
      description: serverTemplates.description,
      iconUrl: serverTemplates.iconUrl,
      sortOrder: serverTemplates.sortOrder,
      createdAt: serverTemplates.createdAt,
      serverName: servers.name,
      serverStatus: servers.status,
    })
    .from(serverTemplates)
    .leftJoin(servers, eq(serverTemplates.serverId, servers.id))
    .orderBy(serverTemplates.sortOrder);

  return templates;
}

export default async function TemplatesAdminPage() {
  const templates = await getTemplates();

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Server Templates</h1>
      <p className="text-slate-400 mb-6">
        Templates allow users to create new servers pre-populated with channels, agents, and settings from an existing server.
      </p>
      <TemplatesManager templates={templates} />
    </div>
  );
}
