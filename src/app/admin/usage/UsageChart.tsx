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
    <div className="rounded-lg bg-slate-800 p-6">
      <h2 className="mb-3 text-sm font-medium text-slate-300">{title}</h2>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} stroke="#475569" />
            <YAxis
              tick={{ fontSize: 11, fill: '#94a3b8' }}
              stroke="#475569"
              tickFormatter={(v) => `$${v}`}
            />
            <Tooltip
              formatter={(v) => `$${Number(v).toFixed(2)}`}
              contentStyle={{
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: 6,
                color: '#e2e8f0',
              }}
              labelStyle={{ color: '#cbd5e1' }}
            />
            <Area
              type="monotone"
              dataKey="dollars"
              stroke="#60a5fa"
              fill="#3b82f6"
              fillOpacity={0.2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
