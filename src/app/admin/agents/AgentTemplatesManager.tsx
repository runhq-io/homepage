'use client';

import { useState } from 'react';
import { addAgentTemplate, removeAgentTemplate, updateAgentTemplate } from './actions';

interface AgentTemplateRow {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  character: string | null;
  model: string | null;
  enabledTools: string[] | null;
  startingCommand: string | null;
  jobStartCommand: string | null;
  autoStartTasks: boolean | null;
  sortOrder: number | null;
  createdAt: Date;
}

const CHARACTERS = ['bot', 'dog', 'fish', 'lobster', 'man', 'witch', 'woman', 'worker'] as const;
const TOOL_OPTIONS = ['terminal', 'files', 'browser'] as const;
const MODEL_OPTIONS = [
  { value: '', label: 'Default (Sonnet 4.6)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
] as const;

function TemplateForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial?: AgentTemplateRow;
  onSubmit: (data: {
    name: string; description: string; systemPrompt: string; character: string;
    model: string; enabledTools: string[]; startingCommand: string; jobStartCommand: string;
    autoStartTasks: boolean; sortOrder: number;
  }) => Promise<void>;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt || '');
  const [character, setCharacter] = useState(initial?.character || '');
  const [model, setModel] = useState(initial?.model || '');
  const [selectedTools, setSelectedTools] = useState<string[]>(initial?.enabledTools || ['terminal', 'files']);
  const [startingCommand, setStartingCommand] = useState(initial?.startingCommand || '');
  const [jobStartCommand, setJobStartCommand] = useState(initial?.jobStartCommand || '');
  const [autoStart, setAutoStart] = useState(initial?.autoStartTasks ?? true);
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleTool(tool: string) {
    setSelectedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(), description, systemPrompt, character, model,
        enabledTools: selectedTools, startingCommand, jobStartCommand,
        autoStartTasks: autoStart, sortOrder,
      });
      if (!initial) {
        // Reset form after adding
        setName(''); setDescription(''); setSystemPrompt(''); setCharacter('');
        setModel(''); setSelectedTools(['terminal', 'files']); setStartingCommand('');
        setJobStartCommand(''); setAutoStart(true); setSortOrder(0);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-700 px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Name <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="e.g. Code Reviewer"
            className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Character</label>
          <select
            value={character}
            onChange={(e) => setCharacter(e.target.value)}
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
        <label className="block text-sm font-medium text-slate-300 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief description of what this agent does"
          className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          placeholder="Instructions for the agent..."
          className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center">
          <label className="flex items-center gap-3 cursor-pointer mt-5">
            <button
              type="button"
              className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${autoStart ? 'bg-blue-600' : 'bg-slate-600'}`}
              onClick={() => setAutoStart(!autoStart)}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${autoStart ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
            <span className="text-sm text-slate-300">Auto-start agent on assignment</span>
          </label>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Enabled Tools</label>
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

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Starting Command</label>
        <input
          type="text"
          value={startingCommand}
          onChange={(e) => setStartingCommand(e.target.value)}
          placeholder="e.g., npm run dev"
          className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-slate-500 mt-1">Runs every time a terminal opens for this agent</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">On Job Start, Run Command</label>
        <textarea
          value={jobStartCommand}
          onChange={(e) => setJobStartCommand(e.target.value)}
          rows={2}
          placeholder={'e.g., claude {{ALL_TASK_DETAILS}} --dangerously-skip-permissions --name {{TASK_ID}}'}
          className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono"
        />
        <p className="text-xs text-slate-500 mt-1">
          Runs once when a job is created. Variables: {'{{TASK_ID}}'} {'{{TASK_TITLE}}'} {'{{TASK_DESCRIPTION}}'} {'{{ALL_TASK_DETAILS}}'} {'{{PROJECT_PATH}}'} {'{{JOB_ID}}'} {'{{AGENT_NAME}}'}
        </p>
      </div>

      <div className="w-32">
        <label className="block text-sm font-medium text-slate-300 mb-1">Sort Order</label>
        <input
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(parseInt(e.target.value) || 0)}
          className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 text-white text-sm font-medium transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-slate-700 hover:bg-slate-600 px-4 py-2 text-slate-300 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function AgentTemplatesManager({ templates }: { templates: AgentTemplateRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    if (!confirm('Delete this agent template?')) return;
    setDeleting(id);
    await removeAgentTemplate(id);
    setDeleting(null);
  }

  return (
    <div className="space-y-8">
      {/* Existing templates */}
      {templates.length > 0 ? (
        <div className="space-y-4">
          {templates.map((t) => (
            <div key={t.id} className="rounded-lg border border-slate-700 overflow-hidden">
              {editingId === t.id ? (
                <div className="p-6">
                  <h3 className="text-md font-semibold text-white mb-4">Edit Template: {t.name}</h3>
                  <TemplateForm
                    initial={t}
                    submitLabel="Save Changes"
                    onCancel={() => setEditingId(null)}
                    onSubmit={async (data) => {
                      await updateAgentTemplate(t.id, data);
                      setEditingId(null);
                    }}
                  />
                </div>
              ) : (
                <div className="flex items-start justify-between p-4 hover:bg-slate-800/50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-white font-medium">{t.name}</span>
                      <span className="text-slate-500 text-xs capitalize">{t.character || '—'}</span>
                      <span className="text-slate-500 text-xs">{t.model || 'default model'}</span>
                      <div className="flex gap-1">
                        {(t.enabledTools || []).map((tool) => (
                          <span key={tool} className="px-1.5 py-0.5 bg-slate-700 rounded text-xs text-slate-300">
                            {tool}
                          </span>
                        ))}
                      </div>
                      {t.autoStartTasks === false && (
                        <span className="px-1.5 py-0.5 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-400">
                          no auto-start
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-slate-400 text-xs">{t.description}</p>
                    )}
                    {t.systemPrompt && (
                      <p className="text-slate-500 text-xs mt-0.5 truncate max-w-2xl" title={t.systemPrompt}>
                        {t.systemPrompt}
                      </p>
                    )}
                    {t.startingCommand && (
                      <p className="text-slate-500 text-xs mt-0.5">
                        Start: <code className="text-slate-400">{t.startingCommand}</code>
                      </p>
                    )}
                    {t.jobStartCommand && (
                      <p className="text-slate-500 text-xs mt-0.5 truncate max-w-2xl">
                        Job: <code className="text-slate-400">{t.jobStartCommand}</code>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 ml-4 shrink-0">
                    <span className="text-slate-500 text-xs">#{t.sortOrder ?? 0}</span>
                    <button
                      onClick={() => setEditingId(t.id)}
                      className="text-blue-400 hover:text-blue-300 text-sm"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={deleting === t.id}
                      className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
                    >
                      {deleting === t.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-slate-700 p-8 text-center text-slate-400">
          No agent templates yet. Add one below.
        </div>
      )}

      {/* Add new template form */}
      <div className="rounded-lg border border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Add Agent Template</h2>

        {addError && (
          <div className="mb-4 rounded-lg bg-red-900/30 border border-red-700 px-4 py-3 text-red-300 text-sm">
            {addError}
          </div>
        )}

        <TemplateForm
          submitLabel="Add Template"
          onSubmit={async (data) => {
            setAddError(null);
            const formData = new FormData();
            formData.set('name', data.name);
            formData.set('description', data.description);
            formData.set('systemPrompt', data.systemPrompt);
            formData.set('character', data.character);
            formData.set('model', data.model);
            formData.set('enabledTools', JSON.stringify(data.enabledTools));
            formData.set('startingCommand', data.startingCommand);
            formData.set('jobStartCommand', data.jobStartCommand);
            formData.set('autoStartTasks', String(data.autoStartTasks));
            formData.set('sortOrder', String(data.sortOrder));
            const result = await addAgentTemplate(formData);
            if (!result.success) {
              throw new Error(result.error || 'Failed to add template');
            }
          }}
        />
      </div>
    </div>
  );
}
