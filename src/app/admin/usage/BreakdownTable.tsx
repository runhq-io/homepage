interface Row {
  key: string;
  label: string;
  cost: number;
  requests: number;
  extra?: string;
}

interface Props {
  title: string;
  rows: Row[];
}

export function BreakdownTable({ title, rows }: Props) {
  return (
    <div className="rounded-lg bg-slate-800">
      <div className="border-b border-slate-700 px-6 py-4 text-sm font-semibold text-white">
        {title}
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-6 py-3 text-left font-medium">Name</th>
            <th className="px-6 py-3 text-right font-medium">Requests</th>
            <th className="px-6 py-3 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-6 py-4 text-slate-500" colSpan={3}>
                No data
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-t border-slate-700/60">
                <td className="px-6 py-3">
                  <div className="font-medium text-slate-100">{r.label}</div>
                  {r.extra && <div className="text-xs text-slate-400">{r.extra}</div>}
                </td>
                <td className="px-6 py-3 text-right tabular-nums text-slate-300">
                  {r.requests.toLocaleString()}
                </td>
                <td className="px-6 py-3 text-right font-medium tabular-nums text-white">
                  ${(r.cost / 100).toFixed(2)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
