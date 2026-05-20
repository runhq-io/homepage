import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, users } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { isAdmin } from '@/lib/adminPolicy';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export interface CallerUser {
  id: string;
  email: string | null;
  isAdmin: boolean;
}

/** Resolve the calling user from a Bearer token; null on missing/invalid. */
async function resolveCaller(req: Request): Promise<CallerUser | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const userId = await extractUserIdFromToken(token);
    if (!userId) return null;
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return null;
    const userIsAdmin = await isAdmin(user.id);
    return { id: user.id, email: user.email ?? null, isAdmin: userIsAdmin };
  } catch {
    return null;
  }
}

/** Returns the calling user, or a `NextResponse` 401 to short-circuit with. */
export async function requireUser(req: Request): Promise<CallerUser | NextResponse> {
  const user = await resolveCaller(req);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: corsHeaders });
  }
  return user;
}

/** Like `requireUser` but also enforces `isAdmin === true`. */
export async function requireAdmin(req: Request): Promise<CallerUser | NextResponse> {
  const userOrRes = await requireUser(req);
  if (userOrRes instanceof NextResponse) return userOrRes;
  if (!userOrRes.isAdmin) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403, headers: corsHeaders });
  }
  return userOrRes;
}

export interface HarnessCaseInput {
  label: string;
  prompt: string;
  expectedOutcome: string;
}

const LIMITS = {
  label: 200,
  prompt: 8 * 1024,
  expectedOutcome: 16 * 1024,
} as const;

export type ParsedBody = { ok: true; value: HarnessCaseInput } | { ok: false; error: string };

export async function parseCaseBody(req: Request): Promise<ParsedBody> {
  let raw: any;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const labelRaw = typeof raw?.label === 'string' ? raw.label.trim() : '';
  const promptRaw = typeof raw?.prompt === 'string' ? raw.prompt.trim() : '';
  const expectedRaw = typeof raw?.expectedOutcome === 'string' ? raw.expectedOutcome.trim() : '';
  if (!labelRaw) return { ok: false, error: 'label is required' };
  if (!promptRaw) return { ok: false, error: 'prompt is required' };
  if (!expectedRaw) return { ok: false, error: 'expectedOutcome is required' };
  if (labelRaw.length > LIMITS.label) return { ok: false, error: `label exceeds ${LIMITS.label} chars` };
  if (promptRaw.length > LIMITS.prompt) return { ok: false, error: `prompt exceeds ${LIMITS.prompt} chars` };
  if (expectedRaw.length > LIMITS.expectedOutcome) {
    return { ok: false, error: `expectedOutcome exceeds ${LIMITS.expectedOutcome} chars` };
  }
  return { ok: true, value: { label: labelRaw, prompt: promptRaw, expectedOutcome: expectedRaw } };
}

export interface HarnessCaseDTO {
  id: string;
  label: string;
  prompt: string;
  expectedOutcome: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toDTO(row: {
  id: string;
  label: string;
  prompt: string;
  expectedOutcome: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): HarnessCaseDTO {
  return {
    id: row.id,
    label: row.label,
    prompt: row.prompt,
    expectedOutcome: row.expectedOutcome,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function jsonResponse(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { status: init?.status ?? 200, headers: corsHeaders });
}
