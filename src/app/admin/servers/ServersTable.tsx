'use client';

import { useState, useTransition } from 'react';
import { destroyMachines } from './actions';
import type { InfrastructureRow } from './page';

type ProviderFilter = 'all' | 'fly' | 'hetzner';
type StatusFilter = 'all' | 'orphaned' | 'matched' | 'stale';

export function ServersTable({ rows }: { rows: InfrastructureRow[] }) {
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const filtered = rows.filter(r => {
    if (providerFilter !== 'all' && r.provider !== providerFilter) return false;
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    return true;
  });

  const selectableRows = filtered.filter(r => r.status === 'orphaned');
  const allSelectableSelected = selectableRows.length > 0 && selectableRows.every(r => selected.has(r.key));

  function toggleAll() {
    if (allSelectableSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableRows.map(r => r.key)));
    }
  }

  function toggleOne(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleDestroy() {
    if (selected.size === 0) return;
    if (!confirm(`Destroy ${selected.size} orphaned machine${selected.size > 1 ? 's' : ''} on the cloud provider? This cannot be undone.`)) return;

    const machines = filtered
      .filter(r => selected.has(r.key) && r.status === 'orphaned')
      .map(r => ({ id: r.machineId, provider: r.provider }));

    startTransition(async () => {
      const result = await destroyMachines(machines);
      if (result.errors.length > 0) {
        alert(`Destroyed ${result.destroyed} machines.\nErrors:\n${result.errors.join('\n')}`);
      }
      setSelected(new Set());
    });
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-4 mb-4">
        <select
          value={providerFilter}
          onChange={e => setProviderFilter(e.target.value as ProviderFilter)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="all">All Providers</option>
          <option value="fly">Fly.io</option>
          <option value="hetzner">Hetzner</option>
        </select>

        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="all">All Statuses</option>
          <option value="orphaned">Orphaned</option>
          <option value="matched">Matched</option>
          <option value="stale">Stale (DB only)</option>
        </select>

        {selected.size > 0 && (
          <button
            type="button"
            onClick={handleDestroy}
            disabled={isPending}
            className="ml-auto px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Destroying...' : `Destroy ${selected.size} selected`}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-700/50">
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allSelectableSelected}
                  onChange={toggleAll}
                  className="rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                Provider
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                Machine
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                State
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                Region
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                Project
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                Owner
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                  No machines found
                </td>
              </tr>
            ) : (
              filtered.map(row => (
                <tr
                  key={row.key}
                  className={`hover:bg-slate-700/30 ${selected.has(row.key) ? 'bg-slate-700/20' : ''} ${row.status === 'orphaned' ? 'bg-red-900/5' : ''}`}
                >
                  <td className="px-4 py-3">
                    {row.status === 'orphaned' ? (
                      <input
                        type="checkbox"
                        checked={selected.has(row.key)}
                        onChange={() => toggleOne(row.key)}
                        className="rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                      />
                    ) : (
                      <span className="block w-4" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ProviderBadge provider={row.provider} />
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-white">{row.machineName}</p>
                      <p className="text-xs text-slate-500 font-mono">{row.machineId}</p>
                      {row.cpuInfo && (
                        <p className="text-xs text-slate-500">{row.cpuInfo}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <MachineStateBadge state={row.machineState} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-slate-300">
                      {row.region?.toUpperCase() || '-'}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <ProjectCell row={row} />
                  </td>
                  <td className="px-4 py-3">
                    {row.ownerName ? (
                      <div>
                        <p className="text-sm text-white">{row.ownerName}</p>
                        <p className="text-xs text-slate-500">{row.ownerEmail}</p>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">-</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-slate-400">
                      {row.createdAt ? formatRelativeTime(row.createdAt) : '-'}
                    </p>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-sm text-slate-500">
        Showing {filtered.length} of {rows.length} machines
      </p>
    </div>
  );
}

function ProviderBadge({ provider }: { provider: 'fly' | 'hetzner' }) {
  if (provider === 'fly') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-purple-900/50 text-purple-300">
        Fly.io
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-900/50 text-blue-300">
      Hetzner
    </span>
  );
}

function MachineStateBadge({ state }: { state: string }) {
  const config: Record<string, { bg: string; text: string; dot: string }> = {
    started: { bg: 'bg-green-900/50', text: 'text-green-300', dot: 'bg-green-400' },
    running: { bg: 'bg-green-900/50', text: 'text-green-300', dot: 'bg-green-400' },
    stopped: { bg: 'bg-slate-700', text: 'text-slate-300', dot: 'bg-slate-400' },
    off: { bg: 'bg-slate-700', text: 'text-slate-300', dot: 'bg-slate-400' },
    suspended: { bg: 'bg-yellow-900/50', text: 'text-yellow-300', dot: 'bg-yellow-400' },
    created: { bg: 'bg-blue-900/50', text: 'text-blue-300', dot: 'bg-blue-400' },
    destroying: { bg: 'bg-red-900/50', text: 'text-red-300', dot: 'bg-red-400' },
    unknown: { bg: 'bg-slate-700', text: 'text-slate-400', dot: 'bg-slate-500' },
  };

  const s = state.toLowerCase();
  const c = config[s] || { bg: 'bg-slate-700', text: 'text-slate-300', dot: 'bg-slate-400' };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {state.charAt(0).toUpperCase() + state.slice(1)}
    </span>
  );
}

function ProjectCell({ row }: { row: InfrastructureRow }) {
  if (row.status === 'orphaned') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-900/50 text-red-300">
        Orphaned
      </span>
    );
  }

  if (row.status === 'stale') {
    return (
      <div>
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-yellow-900/50 text-yellow-300">
          Stale
        </span>
        {row.dbServerName && (
          <p className="text-xs text-slate-500 mt-1">{row.dbServerName}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-white">{row.dbServerName}</p>
      <p className="text-xs text-slate-500 font-mono">{row.dbServerId}</p>
    </div>
  );
}

function formatRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
