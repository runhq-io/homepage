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

  const presetBtn =
    'rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-slate-200 hover:bg-slate-600';
  const dateInput =
    'rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-slate-100 [color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-blue-500';

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-800 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-400">Range:</span>
        <button onClick={() => applyPreset(7)} className={presetBtn}>
          7d
        </button>
        <button onClick={() => applyPreset(30)} className={presetBtn}>
          30d
        </button>
        <button onClick={() => applyPreset(90)} className={presetBtn}>
          90d
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="date"
          className={dateInput}
          value={current.start.toISOString().slice(0, 10)}
          onChange={(e) =>
            update({ start: new Date(e.target.value + 'T00:00:00Z').toISOString() })
          }
        />
        <span className="text-sm text-slate-500">→</span>
        <input
          type="date"
          className={dateInput}
          value={current.end.toISOString().slice(0, 10)}
          onChange={(e) =>
            update({ end: new Date(e.target.value + 'T23:59:59Z').toISOString() })
          }
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-sm text-slate-400">Group by:</span>
        {(['day', 'week', 'month'] as const).map((g) => (
          <button
            key={g}
            onClick={() => update({ groupBy: g })}
            className={`rounded px-2 py-1 text-sm ${
              current.groupBy === g
                ? 'bg-blue-600 text-white'
                : 'border border-slate-600 bg-slate-700 text-slate-200 hover:bg-slate-600'
            }`}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}
