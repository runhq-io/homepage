'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

interface Props {
  data: { bucket: string; totalCostCents: number; requestCount: number }[];
  bucket: 'day' | 'week' | 'month';
}

export function UsageChart({ data, bucket }: Props) {
  const chartData = data.map((d) => ({
    name: d.bucket,
    dollars: d.totalCostCents / 100,
    requests: d.requestCount,
  }));

  const title =
    bucket === 'day' ? 'Daily usage ($)' : bucket === 'week' ? 'Weekly usage ($)' : 'Monthly usage ($)';

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-neutral-700">{title}</h2>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
            <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
            <Area type="monotone" dataKey="dollars" stroke="#111" fill="#111" fillOpacity={0.1} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
