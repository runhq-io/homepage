import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, harnessCases } from '@/db';
import {
  corsHeaders,
  requireAdmin,
  parseCaseBody,
  toDTO,
  jsonResponse,
} from '../_helpers';

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

// PUT /api/harness-cases/:id — replace label/prompt/expectedOutcome. Admin only.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userOrRes = await requireAdmin(req);
  if (userOrRes instanceof NextResponse) return userOrRes;

  const { id } = await params;
  if (!id) return jsonResponse({ error: 'id is required' }, { status: 400 });

  const parsed = await parseCaseBody(req);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, { status: 400 });

  const db = getDb();
  const rows = await db
    .update(harnessCases)
    .set({
      label: parsed.value.label,
      prompt: parsed.value.prompt,
      expectedOutcome: parsed.value.expectedOutcome,
      updatedAt: new Date(),
    })
    .where(eq(harnessCases.id, id))
    .returning();
  if (rows.length === 0) return jsonResponse({ error: 'Case not found' }, { status: 404 });
  return jsonResponse({ data: toDTO(rows[0]) });
}

// DELETE /api/harness-cases/:id. Admin only. Hard delete.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userOrRes = await requireAdmin(req);
  if (userOrRes instanceof NextResponse) return userOrRes;

  const { id } = await params;
  if (!id) return jsonResponse({ error: 'id is required' }, { status: 400 });

  const db = getDb();
  const rows = await db
    .delete(harnessCases)
    .where(eq(harnessCases.id, id))
    .returning({ id: harnessCases.id });
  if (rows.length === 0) return jsonResponse({ error: 'Case not found' }, { status: 404 });
  return jsonResponse({ ok: true });
}
