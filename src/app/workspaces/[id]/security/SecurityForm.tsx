'use client';
import { useState } from 'react';

export function SecurityForm({ orgId, initialRequireMfa, initialEnforcedAt, adoption }: {
  orgId: string;
  initialRequireMfa: boolean;
  initialEnforcedAt: string | null;
  adoption: { total: number; withMfa: number; without: Array<{ userId: string; email: string | null; name: string | null }> };
}) {
  const [requireMfa, setRequireMfa] = useState(initialRequireMfa);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function toggle(next: boolean) {
    setSaving(true); setError('');
    try {
      const res = await fetch(`/api/workspaces/${orgId}/security`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireMfa: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      setRequireMfa(next);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-2xl mx-auto p-8">
      <h1 className="text-2xl font-semibold mb-2">Workspace security</h1>
      <h2 className="text-lg font-semibold mt-6 mb-1">Require two-factor authentication</h2>
      <p className="text-sm text-gray-600 mb-3">Members must enable MFA within 7 days of this setting being turned on. After the grace period, members without MFA will lose access to workspace content until they enable it.</p>
      {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={requireMfa}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>Require MFA for all members</span>
      </label>
      {initialEnforcedAt && requireMfa && (
        <p className="text-xs text-gray-500 mt-2">Enforced since {new Date(initialEnforcedAt).toLocaleDateString()}</p>
      )}
      <div className="mt-6 p-4 bg-gray-50 rounded">
        <p className="text-sm font-medium mb-2">Adoption</p>
        <p className="text-sm text-gray-700">{adoption.withMfa} of {adoption.total} members have MFA enabled.</p>
        {adoption.without.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-gray-600">Members without MFA ({adoption.without.length})</summary>
            <ul className="mt-2 text-sm">
              {adoption.without.map((m) => <li key={m.userId}>{m.name || m.email || m.userId}</li>)}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
