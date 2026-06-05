import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as jose from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, serverMembers, widgetProjects, widgetUsers } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { authenticateWidget, generateUserTokenBySecret } from './WidgetService';

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
    .setIssuedAt() // jwtVerify's maxTokenAge requires iat
    .setExpirationTime('5m')
    .sign(enc);
}

beforeAll(async () => {
  await db.insert(widgetProjects).values({
    serverId: SERVER_ID, workspaceProjectId: 'wsp_perm_test', name: 'Perm Test', slug: PROJECT_SLUG,
    apiKey: API_KEY, apiSecretHash: SECRET, channelId: 'ch_perm_test', enabled: true, isPublic: false,
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

// BE-minted widget tokens (dogfood feedback embed via /api/widget/user-token,
// preview auto-inject) resolve workspace privileges at MINT time: the widget
// key identifies the project → server, and owners/admins get the project's
// configured role claim baked into the JWT. Verification then flows through
// the one shared code path (derivePermissions) like any customer token.
describe('generateUserTokenBySecret — mint-time workspace roles', () => {
  const MT_RUN_HEX = randomBytes(6).toString('hex');
  const MT_SERVER_ID = `ws_perm_mt_${MT_RUN_HEX}`;
  const OWNER_ID = `00000000-0014-4000-a000-${MT_RUN_HEX.padStart(12, '0')}`;
  const PROMOTED_ADMIN_ID = `00000000-0015-4000-a000-${MT_RUN_HEX.padStart(12, '0')}`;
  const PLAIN_MEMBER_ID = `00000000-0016-4000-a000-${MT_RUN_HEX.padStart(12, '0')}`;
  const NON_MEMBER_ID = `00000000-0017-4000-a000-${MT_RUN_HEX.padStart(12, '0')}`;
  const MT_SECRET = `perm-mt-secret-32bytes-${MT_RUN_HEX}`;
  // Mirrors WidgetService.deriveFingerprint — the widget key is the
  // sha256(secret) hex prefix, which is how the mint path finds the project.
  const MT_API_KEY = createHash('sha256').update(MT_SECRET).digest('hex').slice(0, 32);
  let mtProjectId: string;

  function decodeClaims(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  }

  beforeAll(async () => {
    await db.insert(users).values([
      { id: OWNER_ID, email: `mt-owner+${MT_RUN_HEX}@test.invalid`, name: 'MT Owner' },
      { id: PROMOTED_ADMIN_ID, email: `mt-admin+${MT_RUN_HEX}@test.invalid`, name: 'MT Admin' },
      { id: PLAIN_MEMBER_ID, email: `mt-member+${MT_RUN_HEX}@test.invalid`, name: 'MT Member' },
      { id: NON_MEMBER_ID, email: `mt-nonmember+${MT_RUN_HEX}@test.invalid`, name: 'MT NonMember' },
    ]).onConflictDoNothing();
    await db.insert(servers).values({ id: MT_SERVER_ID, name: `MT Srv ${MT_RUN_HEX}`, ownerId: OWNER_ID }).onConflictDoNothing();
    await db.insert(serverMembers).values([
      // Production-realistic rows: owner has is_admin=false; is_admin is the
      // workspace-derived mirror set only for workspace-promoted admins.
      { serverId: MT_SERVER_ID, userId: OWNER_ID, role: 'owner', isAdmin: false },
      { serverId: MT_SERVER_ID, userId: PROMOTED_ADMIN_ID, role: 'member', isAdmin: true },
      { serverId: MT_SERVER_ID, userId: PLAIN_MEMBER_ID, role: 'member', isAdmin: false },
    ]).onConflictDoNothing();
    const [proj] = await db.insert(widgetProjects).values({
      serverId: MT_SERVER_ID, workspaceProjectId: `wsp_perm_mt_${MT_RUN_HEX}`,
      name: `Perm MT ${MT_RUN_HEX}`, slug: `perm-mt-${MT_RUN_HEX}`,
      apiKey: MT_API_KEY, apiSecretHash: MT_SECRET, channelId: `ch_perm_mt_${MT_RUN_HEX}`,
      enabled: true, widgetAgentAssignmentEnabled: true,
      widgetAssignRoles: ['triager'], widgetRoleClaimName: 'runhq_roles',
    }).returning({ id: widgetProjects.id });
    mtProjectId = proj.id;
  });

  afterAll(async () => {
    await db.delete(widgetUsers).where(eq(widgetUsers.projectId, mtProjectId));
    await db.delete(widgetProjects).where(eq(widgetProjects.id, mtProjectId));
    await db.delete(serverMembers).where(eq(serverMembers.serverId, MT_SERVER_ID));
    await db.delete(servers).where(eq(servers.id, MT_SERVER_ID));
    for (const id of [OWNER_ID, PROMOTED_ADMIN_ID, PLAIN_MEMBER_ID, NON_MEMBER_ID]) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it('mints the configured role claim for the workspace owner (role=owner, is_admin=false)', async () => {
    const result = await generateUserTokenBySecret(MT_SECRET, OWNER_ID, 'MT Owner');
    expect(result).not.toBeNull();
    expect(decodeClaims(result!.token).runhq_roles).toEqual(['triager']);
  });

  it('the owner token round-trips through authenticateWidget to assign_agent', async () => {
    const result = await generateUserTokenBySecret(MT_SECRET, OWNER_ID, 'MT Owner');
    const auth = await authenticateWidget(makeReq({ Authorization: `Bearer ${result!.token}` }));
    expect(auth?.permissions.has('assign_agent')).toBe(true);
    expect(auth?.matchedRoles).toEqual(['triager']);
  });

  it('mints the role claim for a workspace-promoted admin (is_admin=true)', async () => {
    const result = await generateUserTokenBySecret(MT_SECRET, PROMOTED_ADMIN_ID, 'MT Admin');
    expect(decodeClaims(result!.token).runhq_roles).toEqual(['triager']);
  });

  it('mints NO role claim for a regular workspace member', async () => {
    const result = await generateUserTokenBySecret(MT_SECRET, PLAIN_MEMBER_ID, 'MT Member');
    expect(decodeClaims(result!.token).runhq_roles).toBeUndefined();
    const auth = await authenticateWidget(makeReq({ Authorization: `Bearer ${result!.token}` }));
    expect(auth?.permissions.has('assign_agent')).toBe(false);
  });

  it('mints NO role claim for a non-member', async () => {
    const result = await generateUserTokenBySecret(MT_SECRET, NON_MEMBER_ID, 'MT NonMember');
    expect(decodeClaims(result!.token).runhq_roles).toBeUndefined();
  });

  it('mints NO role claim for the owner when agent assignment is disabled', async () => {
    await db.update(widgetProjects).set({ widgetAgentAssignmentEnabled: false }).where(eq(widgetProjects.id, mtProjectId));
    const result = await generateUserTokenBySecret(MT_SECRET, OWNER_ID, 'MT Owner');
    expect(decodeClaims(result!.token).runhq_roles).toBeUndefined();
    await db.update(widgetProjects).set({ widgetAgentAssignmentEnabled: true }).where(eq(widgetProjects.id, mtProjectId));
  });

  it('mints NO role claim when no assign roles are configured', async () => {
    await db.update(widgetProjects).set({ widgetAssignRoles: [] }).where(eq(widgetProjects.id, mtProjectId));
    const result = await generateUserTokenBySecret(MT_SECRET, OWNER_ID, 'MT Owner');
    expect(decodeClaims(result!.token).runhq_roles).toBeUndefined();
    await db.update(widgetProjects).set({ widgetAssignRoles: ['triager'] }).where(eq(widgetProjects.id, mtProjectId));
  });
});
