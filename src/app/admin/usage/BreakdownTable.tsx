interface Row {
  key: string;
  label: string;
  cost: number;
  requests: number;
  extra?: string;
  /**
   * Optional deep link. When set, the row's label renders as an anchor.
   * Same-origin URLs use client-side navigation friendliness; external URLs
   * (e.g. app.runhq.io) open in a new tab.
   */
  href?: string;
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
            rows.map((r) => {
              const external = r.href?.startsWith('http');
              const labelContent = (
                <>
                  <div className="font-medium text-slate-100">{r.label}</div>
                  {r.extra && <div className="text-xs text-slate-400">{r.extra}</div>}
                </>
              );
              return (
                <tr key={r.key} className="border-t border-slate-700/60 hover:bg-slate-800/60">
                  <td className="px-6 py-3">
                    {r.href ? (
                      <a
                        href={r.href}
                        {...(external
                          ? { target: '_blank', rel: 'noopener noreferrer' }
                          : {})}
                        className="text-slate-100 hover:text-blue-400 hover:underline"
                      >
                        {labelContent}
                      </a>
                    ) : (
                      labelContent
                    )}
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums text-slate-300">
                    {r.requests.toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-right font-medium tabular-nums text-white">
                    ${(r.cost / 100).toFixed(2)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
