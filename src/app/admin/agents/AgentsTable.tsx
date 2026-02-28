'use client';

import React from 'react';
import Link from 'next/link';
import { DataTable, type DataTableColumn } from '@/components/DataTable';

export type AdminAgentRow = {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  taskCount: number;
  createdBy: string;
  createdAt: Date | string;
};

export function AgentsTable({ rows }: { rows: AdminAgentRow[] }) {
  const columns: Array<DataTableColumn<AdminAgentRow>> = [
    {
      id: 'agent',
      label: 'Agent',
      header: 'Agent',
      disableAutoHide: true,
      minWidth: 260,
      sortable: true,
      sortValue: (r) => r.name,
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href={`/admin/agents/${r.id}`}
              className="text-white font-medium truncate hover:text-blue-300"
            >
              {r.name}
            </Link>
            {r.isPublic && (
              <span className="px-1.5 py-0.5 text-xs bg-green-600/20 text-green-400 rounded flex-shrink-0">
                Public
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      id: 'description',
      label: 'Description',
      header: 'Description',
      minWidth: 360,
      collapsePriority: 20,
      sortable: true,
      sortValue: (r) => r.description ?? '',
      cell: (r) => (
        <span className="text-slate-400 truncate block max-w-[32rem]">{r.description || '—'}</span>
      ),
    },
    {
      id: 'tasks',
      label: 'Tasks',
      header: 'Tasks',
      minWidth: 120,
      collapsePriority: 10,
      sortable: true,
      sortValue: (r) => r.taskCount,
      cell: (r) => <span className="text-slate-300 whitespace-nowrap">{r.taskCount} tasks</span>,
    },
    {
      id: 'machine',
      label: 'State Machine',
      header: 'State Machine',
      minWidth: 160,
      collapsePriority: 30,
      sortable: false,
      cell: () => (
        <span className="inline-flex px-2 py-1 text-xs font-medium bg-slate-600/50 text-slate-300 rounded">
          View
        </span>
      ),
    },
    {
      id: 'createdBy',
      label: 'Created By',
      header: 'Created By',
      minWidth: 200,
      collapsePriority: 25,
      sortable: true,
      sortValue: (r) => r.createdBy,
      cell: (r) => <span className="text-slate-300 truncate block">{r.createdBy}</span>,
    },
    {
      id: 'createdAt',
      label: 'Created',
      header: 'Created',
      minWidth: 140,
      collapsePriority: 15,
      sortable: true,
      sortValue: (r) => (r.createdAt ? new Date(r.createdAt) : null),
      cell: (r) => (
        <span className="text-slate-400 text-sm whitespace-nowrap">
          {new Date(r.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowHref={(r) => `/admin/agents/${r.id}`}
      defaultSort={{ columnId: 'createdAt', direction: 'desc' }}
      emptyState={
        <div>
          <p className="text-lg mb-2">No agents found</p>
          <p className="text-sm">Agents are created from the desktop app</p>
        </div>
      }
    />
  );
}
