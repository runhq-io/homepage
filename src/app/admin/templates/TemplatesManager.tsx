'use client';

import { useState } from 'react';
import { addTemplate, removeTemplate } from './actions';

interface TemplateRow {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  sortOrder: number | null;
  createdAt: Date;
  serverName: string | null;
  serverStatus: string | null;
}

export function TemplatesManager({ templates }: { templates: TemplateRow[] }) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleAdd(formData: FormData) {
    setError(null);
    const result = await addTemplate(formData);
    if (!result.success) {
      setError(result.error || 'Failed to add template');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this template?')) return;
    setDeleting(id);
    await removeTemplate(id);
    setDeleting(null);
  }

  const statusColors: Record<string, string> = {
    online: 'bg-green-500',
    offline: 'bg-slate-500',
    suspended: 'bg-yellow-500',
    provisioning: 'bg-blue-500',
    error: 'bg-red-500',
  };

  return (
    <div className="space-y-8">
      {/* Existing templates */}
      {templates.length > 0 ? (
        <div className="rounded-lg border border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Server</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Order</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-slate-800/50">
                  <td className="px-4 py-3">
                    <div>
                      <span className="text-white font-medium">{t.name}</span>
                      {t.description && (
                        <p className="text-slate-400 text-xs mt-0.5">{t.description}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      <span className="text-slate-300">{t.serverName || 'Unknown'}</span>
                      <p className="text-slate-500 text-xs font-mono">{t.serverId}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${statusColors[t.serverStatus || ''] || 'bg-slate-500'}`} />
                      <span className="text-slate-300 capitalize">{t.serverStatus || 'unknown'}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{t.sortOrder ?? 0}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={deleting === t.id}
                      className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
                    >
                      {deleting === t.id ? 'Removing...' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-700 p-8 text-center text-slate-400">
          No templates configured yet. Add one below.
        </div>
      )}

      {/* Add new template form */}
      <div className="rounded-lg border border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Add Template</h2>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/30 border border-red-700 px-4 py-3 text-red-300 text-sm">
            {error}
          </div>
        )}

        <form action={handleAdd} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Server ID <span className="text-red-400">*</span>
              </label>
              <input
                name="serverId"
                type="text"
                required
                placeholder="ws_..."
                className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Template Name <span className="text-red-400">*</span>
              </label>
              <input
                name="name"
                type="text"
                required
                placeholder="e.g. Web Dev Starter"
                className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Description
            </label>
            <input
              name="description"
              type="text"
              placeholder="Brief description of what this template includes"
              className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Icon URL
              </label>
              <input
                name="iconUrl"
                type="text"
                placeholder="https://..."
                className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Sort Order
              </label>
              <input
                name="sortOrder"
                type="number"
                defaultValue={0}
                className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <button
            type="submit"
            className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 text-white text-sm font-medium transition-colors"
          >
            Add Template
          </button>
        </form>
      </div>
    </div>
  );
}
