import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as jose from 'jose';
import { db } from '../../db/index';
import { widgetProjects } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { authenticateWidget } from './WidgetService';

const SERVER_ID = 'srv_perm_test';
const PROJECT_SLUG = 'perm-test-project';
const API_KEY = 'rw_perm_test_key_xxxxxxxx';
const SECRET = 'perm-test-secret-32bytes-padding-x';

let projectId: string;

function makeReq(headers: Record<string, string>) {
  return { header: (n: string) => headers[n] || headers[n.toLowerCase()] };
}

async function signJwt(payload: Record<string, unknown>) {
  const enc = new TextEncoder().encode(SECRET);
  return await new jose.SignJWT({ type: 'widget_user', fp: API_KEY, sub: 'user-1', name: 'Alice', ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(enc);
}

beforeAll(async () => {
  await db.insert(widgetProjects).values({
    serverId: SERVER_ID, workspaceProjectId: 'wsp_perm_test', name: 'Perm Test', slug: PROJECT_SLUG,
    apiKey: API_KEY, apiSecretHash: SECRET, enabled: true, isPublic: false,
    widgetAgentAssignmentEnabled: false, widgetAssignRoles: [], widgetRoleClaimName: 'runhq_roles',
  }).onConflictDoNothing();
  const [row] = await db.select({ id: widgetProjects.id }).from(widgetProjects).where(eq(widgetProjects.slug, PROJECT_SLUG));
  projectId = row.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, projectId));
});

describe('authenticateWidget — permissions', () => {
  it('grants no permissions when project switch is OFF, even with matching role', async () => {
    const token = await signJwt({ runhq_roles: ['triager'] });
    const result = await authenticateWidget(makeReq({ Authorization: `Bearer ${token}` }));
    expect(result?.permissions.has('assign_agent')).toBe(false);
  });

  it('grants no permissions when switch is ON but JWT has no matching role', async () => {
    await db.update(widgetProjects).set({ widgetAgentAssignmentEnabled: true, widgetAssignRoles: ['triager', 'pm'] }).where(eq(widgetProjects.id, projectId));
    const token = await signJwt({ runhq_roles: ['developer'] });
    const result = await authenticateWidget(makeReq({ Authorization: `Bearer ${token}` }));
    expect(result?.permissions.has('assign_agent')).toBe(false);
  });

  it('grants assign_agent when switch ON and JWT carries matching role under default claim name', async () => {
    await db.update(widgetProjects).set({ widgetAgentAssignmentEnabled: true, widgetAssignRoles: ['triager', 'pm'], widgetRoleClaimName: 'runhq_roles' }).where(eq(widgetProjects.id, projectId));
    const token = await signJwt({ runhq_roles: ['triager'] });
    const result = await authenticateWidget(makeReq({ Authorization: `Bearer ${token}` }));
    expect(result?.permissions.has('assign_agent')).toBe(true);
  });

  it('respects custom claim name override', async () => {
    await db.update(widgetProjects).set({ widgetAgentAssignmentEnabled: true, widgetAssignRoles: ['triager'], widgetRoleClaimName: 'company_roles' }).where(eq(widgetProjects.id, projectId));
    const token = await signJwt({ company_roles: ['triager'] });
    const result = await authenticateWidget(makeReq({ Authorization: `Bearer ${token}` }));
    expect(result?.permissions.has('assign_agent')).toBe(true);
  });

  it('handles non-array claim values gracefully (no throw, denies)', async () => {
    await db.update(widgetProjects).set({ widgetAgentAssignmentEnabled: true, widgetAssignRoles: ['triager'], widgetRoleClaimName: 'runhq_roles' }).where(eq(widgetProjects.id, projectId));
    const token = await signJwt({ runhq_roles: 'triager' });
    const result = await authenticateWidget(makeReq({ Authorization: `Bearer ${token}` }));
    expect(result?.permissions.has('assign_agent')).toBe(false);
  });

  it('returns empty permissions for raw API key auth', async () => {
    const result = await authenticateWidget(makeReq({ Authorization: `Bearer ${API_KEY}` }));
    expect(result?.permissions.size).toBe(0);
  });

  it('returns empty permissions for public slug auth (anonymous)', async () => {
    await db.update(widgetProjects).set({ isPublic: true }).where(eq(widgetProjects.id, projectId));
    const result = await authenticateWidget(makeReq({ 'X-RW-Project': PROJECT_SLUG }));
    expect(result?.permissions.size).toBe(0);
  });
});
