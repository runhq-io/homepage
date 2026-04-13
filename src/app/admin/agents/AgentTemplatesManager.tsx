'use client';

import { useState } from 'react';
import { addAgentTemplate, removeAgentTemplate, updateAgentTemplate } from './actions';

interface AgentTemplateRow {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  character: string | null;
  enabledTools: string[] | null;
  sortOrder: number | null;
  createdAt: Date;
}

const CHARACTERS = ['bot', 'dog', 'fish', 'lobster', 'man', 'witch', 'woman', 'worker'] as const;
const TOOL_OPTIONS = ['terminal', 'files', 'browser'] as const;

export function AgentTemplatesManager({ templates }: { templates: AgentTemplateRow[] }) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedTools, setSelectedTools] = useState<string[]>(['terminal', 'files']);

  async function handleAdd(formData: FormData) {
    setError(null);
    formData.set('enabledTools', JSON.stringify(selectedTools));
    const result = await addAgentTemplate(formData);
    if (!result.success) {
      setError(result.error || 'Failed to add template');
    } else {
      setSelectedTools(['terminal', 'files']);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this agent template?')) return;
    setDeleting(id);
    await removeAgentTemplate(id);
    setDeleting(null);
  }

  function toggleTool(tool: string) {
    setSelectedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  }

  return (
    <div className="space-y-8">
      {/* Existing templates */}
      {templates.length > 0 ? (
        <div className="rounded-lg border border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Character</th>
                <th className="text-left px-4 py-3 font-medium">Tools</th>
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
                      {t.systemPrompt && (
                        <p className="text-slate-500 text-xs mt-0.5 truncate max-w-xs" title={t.systemPrompt}>
                          {t.systemPrompt}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-300 capitalize">{t.character || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 flex-wrap">
                      {(t.enabledTools || []).map((tool) => (
                        <span key={tool} className="px-1.5 py-0.5 bg-slate-700 rounded text-xs text-slate-300">
                          {tool}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{t.sortOrder ?? 0}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={deleting === t.id}
                      className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
                    >
                      {deleting === t.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-700 p-8 text-center text-slate-400">
          No agent templates yet. Add one below.
        </div>
      )}

      {/* Add new template form */}
      <div className="rounded-lg border border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Add Agent Template</h2>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/30 border border-red-700 px-4 py-3 text-red-300 text-sm">
            {error}
          </div>
        )}

        <form action={handleAdd} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                name="name"
                type="text"
                required
                placeholder="e.g. Code Reviewer"
                className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Character
              </label>
              <select
                name="character"
                className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">None</option>
                {CHARACTERS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Description
            </label>
            <input
              name="description"
              type="text"
              placeholder="Brief description of what this agent does"
              className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              System Prompt
            </label>
            <textarea
              name="systemPrompt"
              rows={4}
              placeholder="Instructions for the agent..."
              className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Enabled Tools
            </label>
            <div className="flex gap-3">
              {TOOL_OPTIONS.map((tool) => (
                <label key={tool} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedTools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                    className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-300 capitalize">{tool}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="w-32">
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
