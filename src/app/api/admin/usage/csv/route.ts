import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { streamEventsForCsv } from '@/api/services/UsageReportService';

// Next.js App Router streaming response.
// Guarded by session check — 403 for non-admins.
export async function GET(req: NextRequest) {
  const session = await auth();
  const user = (session?.user as any);
  if (!user?.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(req.url);
  const start = new Date(url.searchParams.get('start') || new Date(Date.now() - 30 * 864e5).toISOString());
  const end   = new Date(url.searchParams.get('end')   || new Date().toISOString());
  const userIds   = url.searchParams.get('userIds')?.split(',').filter(Boolean);
  const serverIds = url.searchParams.get('serverIds')?.split(',').filter(Boolean);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
    return new Response('Invalid date range', { status: 400 });
  }

  const encoder = new TextEncoder();
  const headers = [
    'ts', 'userId', 'serverId', 'model',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
    'costCents',
    'taskId', 'taskLabel', 'channelId', 'channelLabel',
    'agentId', 'agentLabel', 'conversationId', 'anthropicRequestId',
  ];

  // RFC 4180 CSV value escaping.
  const escapeCsv = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(headers.join(',') + '\n'));
      try {
        for await (const row of streamEventsForCsv({ start, end, userIds, serverIds })) {
          const line = [
            (row.ts instanceof Date ? row.ts.toISOString() : row.ts),
            row.userId, row.serverId, row.model,
            row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens,
            row.costCents,
            row.taskId, row.taskLabel, row.channelId, row.channelLabel,
            row.agentId, row.agentLabel, row.conversationId, row.anthropicRequestId,
          ].map(escapeCsv).join(',') + '\n';
          controller.enqueue(encoder.encode(line));
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });

  const fname = `usage-${start.toISOString().slice(0, 10)}-to-${end.toISOString().slice(0, 10)}.csv`;
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    },
  });
}
