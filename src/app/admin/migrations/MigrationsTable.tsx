'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { migrateOne, createLegacyTestWorkspace } from './actions';
import type { MigrationResult } from '@/api/services/ServerService';

export type WorkspaceRow = {
  id: string;
  name: string;
  machineId: string | null;
  volumeId: string | null;
  flyAppName: string | null;
  flyNetworkName: string | null;
  region: string | null;
  status: string | null;
  tier: string | null;
  /** ISO string (server-rendered Date is unsafe to pass through to client). */
  createdAt: string;
  ownerEmail: string | null;
  ownerName: string | null;
};

type MigrationOutcome =
  | { kind: 'success'; result: MigrationResult }
  | { kind: 'error'; message: string };

export function MigrationsTable({
  eligible,
  migrated,
}: {
  eligible: WorkspaceRow[];
  migrated: WorkspaceRow[];
}) {
  const router = useRouter();
  // Set rather than single string so simultaneous clicks on multiple rows
  // each show their own spinner. The underlying server actions are
  // independent and run in parallel — we just need the UI to reflect it.
  const [activeServerIds, setActiveServerIds] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, MigrationOutcome>>({});
  // We track per-row in-flight state via `activeServerIds` (above) rather
  // than `useTransition`'s single boolean — useTransition's `isPending` is
  // true while ANY transition is in flight, which loses the per-row
  // resolution we want. The transition is still useful for batching the
  // setState calls inside the async handler.
  const [, startTransition] = useTransition();

  function isMigratable(row: WorkspaceRow): boolean {
    return row.machineId !== null && row.volumeId !== null;
  }

  function handleMigrate(row: WorkspaceRow): void {
    if (!isMigratable(row)) {
      alert(
        `Cannot migrate ${row.id}: row is missing ${
          row.machineId === null ? 'machineId' : 'volumeId'
        }. The migrator needs both. Manual triage required.`,
      );
      return;
    }

    const confirmed = confirm(
      `Migrate ${row.name} (${row.id}) to its own Fly app?\n\n` +
        `Recommended: close all browser tabs and SSH sessions to this\n` +
        `workspace before continuing. The migration disables autostart\n` +
        `on the old machine to keep the volume quiesced during snapshot,\n` +
        `but reducing live traffic also speeds the snapshot up.\n\n` +
        `Steps:\n` +
        `  • Stop the existing machine and disable its autostart (~30s)\n` +
        `  • Snapshot the volume (~1-2 min, up to 10 min cap)\n` +
        `  • Create a new ws-* Fly app on an isolated 6PN network\n` +
        `  • Restore the snapshot into the new app and start a new machine\n` +
        `  • Cutover the DB row to point at the new resources\n` +
        `  • Delete the old machine + volume from the shared app\n\n` +
        `Total ~2-3 minutes; the workspace machine is offline during cutover\n` +
        `(the management UI / TODOs / files-from-DB still load — these are\n` +
        `BE-side and unaffected). Cancel to abort.`,
    );
    if (!confirmed) return;

    setActiveServerIds((prev) => {
      const next = new Set(prev);
      next.add(row.id);
      return next;
    });
    startTransition(async () => {
      try {
        const result = await migrateOne(row.id);
        setOutcomes((prev) => ({
          ...prev,
          [row.id]: { kind: 'success', result },
        }));
        // Server action revalidated the path; refresh router-side cache to
        // pick up the new row state (flyAppName populated, status updated).
        router.refresh();
      } catch (err) {
        setOutcomes((prev) => ({
          ...prev,
          [row.id]: {
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      } finally {
        setActiveServerIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
      }
    });
  }

  return (
    <div className="space-y-12">
      <CreateLegacyTestWorkspacePanel />

      <Section
        title="Eligible (legacy shared app)"
        subtitle={`${eligible.length} workspace${eligible.length === 1 ? '' : 's'} still on the shared Fly app — fly_app_name IS NULL`}
        emptyMessage="No legacy workspaces. All remote workspaces are on per-tenant apps."
      >
        <Table
          rows={eligible}
          actionColumn
          renderAction={(row) => {
            const outcome = outcomes[row.id];
            const isActive = activeServerIds.has(row.id);
            const migratable = isMigratable(row);

            if (outcome?.kind === 'success') {
              return (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-green-900/40 text-green-300">
                  Migrated → {outcome.result.newAppName}
                </span>
              );
            }
            if (outcome?.kind === 'error') {
              return (
                <span
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-900/50 text-red-300 cursor-help"
                  title={outcome.message}
                >
                  Error — hover for details
                </span>
              );
            }

            return (
              <button
                type="button"
                onClick={() => handleMigrate(row)}
                disabled={isActive || !migratable}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
              >
                {isActive && (
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {isActive ? 'Migrating…' : migratable ? 'Migrate' : 'No machine/volume'}
              </button>
            );
          }}
        />
      </Section>

      <Section
        title="Already migrated (per-tenant apps)"
        subtitle={`${migrated.length} workspace${migrated.length === 1 ? '' : 's'} on dedicated ws-* apps`}
        emptyMessage="No workspaces have been migrated yet."
      >
        <Table rows={migrated} />
      </Section>
    </div>
  );
}

type CreateOutcome =
  | { kind: 'success'; serverId: string; machineId: string }
  | { kind: 'error'; message: string };

function CreateLegacyTestWorkspacePanel() {
  const router = useRouter();
  const [name, setName] = useState('migration-test');
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate(): void {
    if (!name.trim()) return;
    startTransition(async () => {
      try {
        const result = await createLegacyTestWorkspace(name);
        setOutcome({ kind: 'success', serverId: result.serverId, machineId: result.machineId });
        router.refresh();
      } catch (err) {
        setOutcome({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return (
    <section className="bg-slate-800/30 border border-slate-700/50 rounded-lg p-5">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-white">Create test legacy workspace</h2>
          <p className="mt-1 text-sm text-slate-400 max-w-xl">
            Provisions a workspace in the shared Fly app
            {' '}<code className="px-1 py-0.5 rounded bg-slate-900/60 text-slate-300 font-mono text-xs">runhq-workspaces-staging</code>{' '}
            with{' '}<code className="px-1 py-0.5 rounded bg-slate-900/60 text-slate-300 font-mono text-xs">fly_app_name = NULL</code>{' '}
            on the row — same shape as a pre-Phase-2 workspace. Use this to
            verify the migration flow end-to-end without redeploying master.
            Bypasses the Stripe payment gate. Owned by you; appears in your
            normal workspace list.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="workspace name"
            disabled={isPending}
            maxLength={100}
            className="px-3 py-1.5 rounded-md bg-slate-900 border border-slate-700 text-sm text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={isPending || !name.trim()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
          >
            {isPending && (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {isPending ? 'Provisioning…' : 'Create'}
          </button>
        </div>
      </div>

      {outcome?.kind === 'success' && (
        <p className="mt-3 text-sm text-emerald-300">
          Created{' '}
          <code className="px-1 py-0.5 rounded bg-emerald-900/40 text-emerald-200 font-mono text-xs">
            {outcome.serverId}
          </code>
          {' '}(machine{' '}
          <code className="px-1 py-0.5 rounded bg-emerald-900/40 text-emerald-200 font-mono text-xs">
            {outcome.machineId}
          </code>
          ). It now appears in the &ldquo;Eligible&rdquo; table below — open it,
          add some test data, then click Migrate to verify the flow.
        </p>
      )}
      {outcome?.kind === 'error' && (
        <p className="mt-3 text-sm text-red-300">
          Failed: <span className="font-mono text-xs">{outcome.message}</span>
        </p>
      )}
    </section>
  );
}

function Section({
  title,
  subtitle,
  emptyMessage,
  children,
}: {
  title: string;
  subtitle: string;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="text-sm text-slate-400 mt-0.5">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function Table({
  rows,
  actionColumn,
  renderAction,
}: {
  rows: WorkspaceRow[];
  actionColumn?: boolean;
  renderAction?: (row: WorkspaceRow) => React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg px-4 py-8 text-center text-sm text-slate-500">
        Empty.
      </div>
    );
  }

  return (
    <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-700/40">
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Workspace</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Owner</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Fly App</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Machine</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Volume</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Region</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Status</th>
              {actionColumn && (
                <th className="px-4 py-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">Action</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-700/20">
                <td className="px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-white">{row.name}</p>
                    <p className="text-xs text-slate-500 font-mono">{row.id}</p>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {row.ownerName ? (
                    <div>
                      <p className="text-sm text-white">{row.ownerName}</p>
                      <p className="text-xs text-slate-500">{row.ownerEmail}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">—</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.flyAppName ? (
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-mono bg-purple-900/40 text-purple-300">
                      {row.flyAppName}
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-amber-900/40 text-amber-300">
                      legacy (shared app)
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs font-mono text-slate-400">
                  {row.machineId || <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-3 text-xs font-mono text-slate-400">
                  {row.volumeId || <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-3 text-sm text-slate-300">
                  {row.region?.toUpperCase() || '—'}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={row.status} />
                </td>
                {actionColumn && renderAction && (
                  <td className="px-4 py-3 text-right">{renderAction(row)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { className: string; label: string }> = {
    online: { className: 'bg-green-900/40 text-green-300', label: 'online' },
    offline: { className: 'bg-slate-700/60 text-slate-300', label: 'offline' },
    provisioning: { className: 'bg-blue-900/50 text-blue-300', label: 'provisioning' },
    error: { className: 'bg-red-900/50 text-red-300', label: 'error' },
    suspended: { className: 'bg-amber-900/40 text-amber-300', label: 'suspended' },
  };
  const entry = status ? map[status] : null;
  return (
    <span
      className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
        entry?.className ?? 'bg-slate-700/60 text-slate-400'
      }`}
    >
      {entry?.label ?? status ?? '—'}
    </span>
  );
}
