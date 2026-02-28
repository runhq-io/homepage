'use client';

import { useState } from 'react';

interface Agent {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  isFavorite: boolean;
}

interface AgentsListProps {
  agents: Agent[];
}

export function AgentsList({ agents }: AgentsListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (agents.length === 0) {
    return <p className="text-slate-500 text-sm">No agents</p>;
  }

  return (
    <div className="space-y-2">
      {agents.map((agent) => (
        <div key={agent.id} className="bg-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
            className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-700/70 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              {agent.isFavorite && <span className="text-yellow-400 text-sm">★</span>}
              <span className="text-white font-medium truncate">{agent.name}</span>
              {agent.description && (
                <span className="text-slate-400 text-sm truncate hidden sm:inline">
                  — {agent.description}
                </span>
              )}
            </div>
            <svg
              className={`w-4 h-4 text-slate-400 transition-transform ${expandedId === agent.id ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {expandedId === agent.id && (
            <div className="px-3 pb-3 border-t border-slate-600/50">
              <div className="mt-2">
                <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">System Prompt</p>
                {agent.systemPrompt ? (
                  <pre className="text-sm text-slate-300 bg-slate-800 rounded p-2 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono text-xs">
                    {agent.systemPrompt}
                  </pre>
                ) : (
                  <p className="text-slate-500 text-sm italic">No system prompt defined</p>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
