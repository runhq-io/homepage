'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

interface Props {
  current: {
    start: Date;
    end: Date;
    groupBy: 'day' | 'week' | 'month';
  };
}

export function UsageFilters({ current }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const update = useCallback(
    (patch: Record<string, string | undefined>) => {
      const params = new URLSearchParams(sp?.toString() ?? '');
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '') params.delete(k);
        else params.set(k, v);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [sp, pathname, router],
  );

  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 864e5);
    update({ start: start.toISOString(), end: end.toISOString() });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-600">Range:</span>
        <button
          onClick={() => applyPreset(7)}
          className="rounded border px-2 py-1 text-sm hover:bg-neutral-50"
        >
          7d
        </button>
        <button
          onClick={() => applyPreset(30)}
          className="rounded border px-2 py-1 text-sm hover:bg-neutral-50"
        >
          30d
        </button>
        <button
          onClick={() => applyPreset(90)}
          className="rounded border px-2 py-1 text-sm hover:bg-neutral-50"
        >
          90d
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="date"
          className="rounded border px-2 py-1 text-sm"
          value={current.start.toISOString().slice(0, 10)}
          onChange={(e) =>
            update({ start: new Date(e.target.value + 'T00:00:00Z').toISOString() })
          }
        />
        <span className="text-sm text-neutral-400">→</span>
        <input
          type="date"
          className="rounded border px-2 py-1 text-sm"
          value={current.end.toISOString().slice(0, 10)}
          onChange={(e) =>
            update({ end: new Date(e.target.value + 'T23:59:59Z').toISOString() })
          }
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-sm text-neutral-600">Group by:</span>
        {(['day', 'week', 'month'] as const).map((g) => (
          <button
            key={g}
            onClick={() => update({ groupBy: g })}
            className={`rounded px-2 py-1 text-sm ${
              current.groupBy === g ? 'bg-black text-white' : 'border hover:bg-neutral-50'
            }`}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}
