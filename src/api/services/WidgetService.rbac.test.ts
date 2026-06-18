/**
 * Tests for the RBAC permission-derivation layer introduced in
 * 2026-06-18-widget-rbac-live-coder.sql.
 *
 * Uses a real Postgres test DB (configured via .env DATABASE_URL).
 * Inserts an isolated project with a widgetRolePermissions map and verifies
 * that authenticateWidget correctly derives the permission set from JWT roles.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as jose from 'jose';
import { db } from '../../db/index.js';
import { widgetProjects } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { authenticateWidget } from './WidgetService.js';

const SLUG = 'rbac-test', API_KEY = 'pk_rbac', SECRET = 'shh_rbac', SERVER_ID = 'srv_rbac';
let projectId = '';
async function signJwt(p: Record<string, unknown>) {
  return new jose.SignJWT({ type: 'widget_user', fp: API_KEY, sub: 'u1', name: 'Sam', ...p })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}
const makeReq = (h: Record<string, string>) => ({ header: (n: string) => h[n] || h[n.toLowerCase()] }) as any;

beforeAll(async () => {
  await db.insert(widgetProjects).values({
    serverId: SERVER_ID, workspaceProjectId: 'wsp_rbac', name: 'RBAC', slug: SLUG,
    apiKey: API_KEY, apiSecretHash: SECRET, channelId: 'ch_rbac', enabled: true, isPublic: false,
    widgetAgentAssignmentEnabled: false, widgetAssignRoles: [], widgetRoleClaimName: 'runhq_roles',
    widgetRolePermissions: { team_member: ['assign_agent', 'live_coder'], '*': ['attach_image'] },
    widgetLiveCoderEnabled: true,
  }).onConflictDoNothing();
  const [row] = await db.select({ id: widgetProjects.id }).from(widgetProjects).where(eq(widgetProjects.slug, SLUG));
  projectId = row.id;
});
afterAll(async () => { await db.delete(widgetProjects).where(eq(widgetProjects.id, projectId)); });

describe('derivePermissions (RBAC)', () => {
  it('grants a role its mapped permissions plus wildcard', async () => {
    const token = await signJwt({ runhq_roles: ['team_member'] });
    const r = await authenticateWidget(makeReq({ Authorization: `Bearer ${token}`, 'X-RW-Project': SLUG }));
    expect(r?.permissions.has('live_coder')).toBe(true);
    expect(r?.permissions.has('attach_image')).toBe(true);
    expect(r?.matchedRoles).toContain('team_member');
  });
  it('a non-staff role gets only wildcard permissions', async () => {
    const token = await signJwt({ runhq_roles: ['customer'] });
    const r = await authenticateWidget(makeReq({ Authorization: `Bearer ${token}`, 'X-RW-Project': SLUG }));
    expect(r?.permissions.has('live_coder')).toBe(false);
    expect(r?.permissions.has('attach_image')).toBe(true);
  });
});
