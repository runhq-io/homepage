'use client';

import { useState } from 'react';
import { updateSettings } from './actions';

interface SettingsFormProps {
  initialSettings: Record<string, string | null>;
}

export function SettingsForm({ initialSettings }: SettingsFormProps) {
  const [settings, setSettings] = useState({
    claude_api_key: initialSettings['claude_api_key'] || '',
    claude_model: initialSettings['claude_model'] || 'claude-sonnet-4-20250514',
    system_prompt: initialSettings['system_prompt'] || '',
    max_actions_per_task: initialSettings['max_actions_per_task'] || '50',
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      await updateSettings(settings);
      setMessage({ type: 'success', text: 'Settings saved successfully' });
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-slate-800 rounded-lg p-6 space-y-6">
        <h2 className="text-lg font-semibold text-white border-b border-slate-700 pb-3">
          Claude API Configuration
        </h2>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">API Key</label>
          <input
            type="password"
            value={settings.claude_api_key}
            onChange={(e) => setSettings({ ...settings, claude_api_key: e.target.value })}
            placeholder="sk-ant-..."
            className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-slate-400">Your Anthropic API key for Claude inference</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Model</label>
          <select
            value={settings.claude_model}
            onChange={(e) => setSettings({ ...settings, claude_model: e.target.value })}
            className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="claude-opus-4-20250514">Claude Opus 4</option>
            <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
            <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
          </select>
          <p className="mt-1 text-xs text-slate-400">The Claude model to use for agent inference</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Max Actions Per Task</label>
          <input
            type="number"
            value={settings.max_actions_per_task}
            onChange={(e) => setSettings({ ...settings, max_actions_per_task: e.target.value })}
            min="1"
            max="200"
            className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-slate-400">Maximum number of actions an agent can take in a single task</p>
        </div>
      </div>

      <div className="bg-slate-800 rounded-lg p-6 space-y-6">
        <h2 className="text-lg font-semibold text-white border-b border-slate-700 pb-3">System Prompt</h2>
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Base System Prompt</label>
          <textarea
            value={settings.system_prompt}
            onChange={(e) => setSettings({ ...settings, system_prompt: e.target.value })}
            rows={10}
            placeholder="You are an AI assistant that helps users accomplish tasks in a web browser..."
            className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
          />
          <p className="mt-1 text-xs text-slate-400">The base system prompt prepended to all agent interactions</p>
        </div>
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-lg ${message.type === 'success' ? 'bg-green-600/20 text-green-400' : 'bg-red-600/20 text-red-400'}`}>
          {message.text}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </form>
  );
}
