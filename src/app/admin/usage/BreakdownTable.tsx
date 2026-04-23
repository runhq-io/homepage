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
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 p-3 text-sm font-medium text-neutral-700">
        {title}
      </div>
      <table className="w-full text-sm">
        <thead className="text-neutral-500">
          <tr>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-right">Requests</th>
            <th className="px-3 py-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-4 text-neutral-400" colSpan={3}>
                No data
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-t border-neutral-50">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.label}</div>
                  {r.extra && <div className="text-xs text-neutral-500">{r.extra}</div>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.requests.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
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
