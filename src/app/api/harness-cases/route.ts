import { NextResponse } from 'next/server';
import { asc } from 'drizzle-orm';
import { getDb, harnessCases } from '@/db';
import {
  corsHeaders,
  requireUser,
  requireAdmin,
  parseCaseBody,
  toDTO,
  jsonResponse,
} from './_helpers';

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

// GET /api/harness-cases — list all shared cases. Any authenticated user.
export async function GET(req: Request) {
  const userOrRes = await requireUser(req);
  if (userOrRes instanceof NextResponse) return userOrRes;

  const db = getDb();
  const rows = await db
    .select()
    .from(harnessCases)
    .orderBy(asc(harnessCases.createdAt));
  return jsonResponse({ data: rows.map(toDTO) });
}

// POST /api/harness-cases — create a case. Admin only.
export async function POST(req: Request) {
  const userOrRes = await requireAdmin(req);
  if (userOrRes instanceof NextResponse) return userOrRes;
  const user = userOrRes;

  const parsed = await parseCaseBody(req);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, { status: 400 });

  const id = crypto.randomUUID();
  const now = new Date();
  const db = getDb();
  const [row] = await db
    .insert(harnessCases)
    .values({
      id,
      label: parsed.value.label,
      prompt: parsed.value.prompt,
      expectedOutcome: parsed.value.expectedOutcome,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return jsonResponse({ data: toDTO(row) }, { status: 201 });
}
