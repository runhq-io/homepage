'use client';

import React from 'react';
import Link from 'next/link';

import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { UserActions } from './UserActions';

export type AdminUserRow = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isActivated: boolean | null;
  planName: string;
  balanceCents: number;
  totalUsageCents: number;
  totalPurchasedCents: number;
  isAdmin: boolean;
  lastLoginAt: Date | string | null;
  authProvider: string | null;
};

function formatDollars(cents: number): string {
  if (!cents) return '$0.00';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return 'Never';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function planBadgeClass(planName: string) {
  if (planName === 'team') return 'bg-purple-600/30 text-purple-300';
  if (planName === 'pro') return 'bg-blue-600/30 text-blue-300';
  if (planName === 'starter') return 'bg-green-600/30 text-green-300';
  return 'bg-slate-600/50 text-slate-400';
}

export function UsersTable({ rows }: { rows: AdminUserRow[] }) {
  const columns: Array<DataTableColumn<AdminUserRow>> = [
    {
      id: 'user',
      label: 'User',
      header: 'User',
      disableAutoHide: true,
      minWidth: 260,
      sortable: true,
      sortValue: (r) => r.name ?? 'Unknown',
      cell: (r) => (
        <Link href={`/admin/users/${r.id}`} className="flex items-center gap-2 min-w-0 hover:opacity-80">
          {r.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.avatarUrl} alt="" className="h-7 w-7 rounded-full flex-shrink-0" />
          ) : (
            <div className="h-7 w-7 rounded-full bg-slate-600 flex items-center justify-center text-xs text-slate-200 flex-shrink-0">
              {(r.name ?? '?').charAt(0)}
            </div>
          )}
          <div className="min-w-0">
            <span className="text-white text-sm font-medium truncate block">{r.name || 'Unknown'}</span>
            {r.email && <span className="text-slate-500 text-xs truncate block">{r.email}</span>}
          </div>
        </Link>
      ),
    },
    {
      id: 'email',
      label: 'Email',
      header: 'Email',
      minWidth: 260,
      collapsePriority: 40,
      sortable: true,
      sortValue: (r) => r.email ?? '',
      cell: (r) => <span className="text-slate-400 text-sm truncate block">{r.email ?? '\u2014'}</span>,
    },
    {
      id: 'status',
      label: 'Status',
      header: 'Status',
      minWidth: 140,
      collapsePriority: 15,
      sortable: true,
      sortValue: (r) => Boolean(r.isActivated),
      cell: (r) =>
        r.isActivated ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-slate-600" />
            Inactive
          </span>
        ),
    },
    {
      id: 'plan',
      label: 'Plan',
      header: 'Plan',
      minWidth: 120,
      collapsePriority: 25,
      sortable: true,
      sortValue: (r) => r.planName,
      cell: (r) => (
        <span className={`text-xs px-1.5 py-0.5 rounded capitalize ${planBadgeClass(r.planName)}`}>
          {r.planName}
        </span>
      ),
    },
    {
      id: 'balance',
      label: 'Balance',
      header: 'Balance',
      minWidth: 120,
      collapsePriority: 35,
      sortable: true,
      sortValue: (r) => r.balanceCents,
      cell: (r) => <span className="text-xs text-green-400 font-medium">{formatDollars(r.balanceCents)}</span>,
    },
    {
      id: 'usage',
      label: 'Usage',
      header: 'Usage',
      minWidth: 120,
      collapsePriority: 36,
      sortable: true,
      sortValue: (r) => r.totalUsageCents,
      align: 'right',
      cell: (r) => <span className="text-xs text-orange-400">{formatDollars(r.totalUsageCents)}</span>,
    },
    {
      id: 'purchased',
      label: 'Purchased',
      header: 'Purchased',
      minWidth: 130,
      collapsePriority: 37,
      sortable: true,
      sortValue: (r) => r.totalPurchasedCents,
      align: 'right',
      cell: (r) => <span className="text-xs text-slate-400">{formatDollars(r.totalPurchasedCents)}</span>,
    },
    {
      id: 'role',
      label: 'Role',
      header: 'Role',
      minWidth: 110,
      collapsePriority: 30,
      sortable: true,
      sortValue: (r) => (r.isAdmin ? 1 : 0),
      cell: (r) =>
        r.isAdmin ? (
          <span className="text-xs px-1.5 py-0.5 bg-blue-600/30 text-blue-300 rounded">Admin</span>
        ) : (
          <span className="text-xs px-1.5 py-0.5 bg-slate-600/30 text-slate-300 rounded">User</span>
        ),
    },
    {
      id: 'lastLogin',
      label: 'Last Login',
      header: 'Last Login',
      minWidth: 140,
      collapsePriority: 38,
      sortable: true,
      sortValue: (r) => (r.lastLoginAt ? new Date(r.lastLoginAt) : null),
      align: 'right',
      cell: (r) => (
        <span className="text-xs text-slate-500 whitespace-nowrap">
          {formatRelativeTime(r.lastLoginAt ? new Date(r.lastLoginAt) : null)}
        </span>
      ),
    },
    {
      id: 'actions',
      label: 'Actions',
      header: '',
      minWidth: 64,
      disableAutoHide: true,
      sortable: false,
      hideInRowDetails: true,
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end" data-row-click="ignore">
          <UserActions userId={r.id} isActivated={r.isActivated ?? false} userName={r.name} />
        </div>
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowHref={(r) => `/admin/users/${r.id}`}
      defaultSort={{ columnId: 'lastLogin', direction: 'desc' }}
      emptyState={<p>No users found</p>}
      minVisibleColumns={2}
    />
  );
}
