import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { db } from '../../db/index';
import { users, servers, serverMembers, widgetProjects, widgetUsers } from '../../db/schema';
import { authenticateWidget } from './WidgetService';
import { csrfTokenFor } from './WidgetCookieAuth';

// Tests Mode 0 (rw_session cookie + workspace membership) of authenticateWidget.
// Spec: docs/superpowers/specs/2026-05-10-widget-runhq-member-detection-design.md

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_ca_test_${RUN_HEX}`;
const ADMIN_USER_ID = `00000000-0004-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const MEMBER_USER_ID = `00000000-0005-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const NON_MEMBER_USER_ID = `00000000-0006-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const OWNER_USER_ID = `00000000-0007-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const ALLOWED_ORIGIN = 'https://acme.test';
const OTHER_ORIGIN = 'https://malicious.test';

let PROJECT_ENABLED_ID: string;
let PROJECT_DISABLED_ID: string;
let PROJECT_RBAC_ID: string;
let PROJECT_STAFF_ID: string;
const PROJECT_ENABLED_SLUG = `enabled-${RUN_HEX}`;
const PROJECT_DISABLED_SLUG = `disabled-${RUN_HEX}`;
const PROJECT_RBAC_SLUG = `rbac-${RUN_HEX}`;
const PROJECT_STAFF_SLUG = `staff-${RUN_HEX}`;

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

async function makeRwSession(userId: string): Promise<{ token: string; iat: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const token = await new jose.SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(JWT_SECRET));
  return { token, iat };
}

interface MockReq {
  cookieHeader: string;
  origin?: string;
  slug?: string;
  method?: string;
  csrf?: string;
  authorization?: string;
}

function buildReq({ cookieHeader, origin, slug, method, csrf, authorization }: MockReq) {
  const headers: Record<string, string> = { Cookie: cookieHeader };
  if (origin) headers['Origin'] = origin;
  if (slug) headers['X-RW-Project'] = slug;
  if (csrf) headers['X-RunHQ-CSRF'] = csrf;
  if (authorization) headers['Authorization'] = authorization;
  return {
    header(name: string) {
      // Hono's header lookup is case-insensitive; mimic that.
      const lower = name.toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lower) return headers[k];
      }
      return undefined;
    },
    method,
  };
}

beforeAll(async () => {
  await db.insert(users).values([
    { id: ADMIN_USER_ID, email: `admin+${RUN_HEX}@test.invalid`, name: 'Admin' },
    { id: MEMBER_USER_ID, email: `member+${RUN_HEX}@test.invalid`, name: 'Member' },
    { id: NON_MEMBER_USER_ID, email: `nonmember+${RUN_HEX}@test.invalid`, name: 'Non-Member' },
    { id: OWNER_USER_ID, email: `owner+${RUN_HEX}@test.invalid`, name: 'Owner' },
  ]).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: OWNER_USER_ID }).onConflictDoNothing();
  await db.insert(serverMembers).values([
    // Production-realistic rows: owners are stamped role='owner' with
    // is_admin=false (is_admin is the workspace-derived mirror, only set
    // for workspace-PROMOTED admins — see ServerService.checkCloudOpPermission).
    { serverId: SERVER_ID, userId: OWNER_USER_ID, role: 'owner', isAdmin: false },
    { serverId: SERVER_ID, userId: ADMIN_USER_ID, role: 'member', isAdmin: true },
    { serverId: SERVER_ID, userId: MEMBER_USER_ID, role: 'member', isAdmin: false },
  ]).onConflictDoNothing();

  const [enabled] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Enabled ${RUN_HEX}`,
    slug: PROJECT_ENABLED_SLUG,
    apiKey: `ekey-${RUN_HEX}`,
    apiSecretHash: `esecret-${RUN_HEX}`,
    channelId: `ch_ca_e_${RUN_HEX}`,
    enabled: true,
    autoRecognizeRunhqMembers: true,
    allowedOrigins: [ALLOWED_ORIGIN],
    widgetAgentAssignmentEnabled: true,
    widgetAssignRoles: ['some-role'],
    // RBAC map: team_member (owner/admin) → assign_agent; mirrors what the
    // Task-1 migration writes for pre-existing projects with the legacy flag.
    widgetRolePermissions: { team_member: ['assign_agent'] },
  }).returning({ id: widgetProjects.id });
  PROJECT_ENABLED_ID = enabled.id;

  const [disabled] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Disabled ${RUN_HEX}`,
    slug: PROJECT_DISABLED_SLUG,
    apiKey: `dkey-${RUN_HEX}`,
    apiSecretHash: `dsecret-${RUN_HEX}`,
    channelId: `ch_ca_d_${RUN_HEX}`,
    enabled: true,
    autoRecognizeRunhqMembers: false, // opt-in OFF
    allowedOrigins: [ALLOWED_ORIGIN],
  }).returning({ id: widgetProjects.id });
  PROJECT_DISABLED_ID = disabled.id;

  // RBAC project: uses widgetRolePermissions map (not legacy flag).
  // team_member → ['assign_agent', 'live_coder']; '*' wildcard → ['attach_image']
  const [rbac] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `RBAC ${RUN_HEX}`,
    slug: PROJECT_RBAC_SLUG,
    apiKey: `rkey-${RUN_HEX}`,
    apiSecretHash: `rsecret-${RUN_HEX}`,
    channelId: `ch_ca_r_${RUN_HEX}`,
    enabled: true,
    autoRecognizeRunhqMembers: true,
    allowedOrigins: [ALLOWED_ORIGIN],
    widgetRoleClaimName: 'runhq_roles',
    widgetRolePermissions: { team_member: ['assign_agent', 'live_coder'], '*': ['attach_image'] },
  }).returning({ id: widgetProjects.id });
  PROJECT_RBAC_ID = rbac.id;

  // Staff-convention project: configures permissions under the `staff` role —
  // the label the widget settings UI suggests. Workspace admins must map onto
  // it automatically via the cookie-auth synthetic payload.
  const [staff] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Staff ${RUN_HEX}`,
    slug: PROJECT_STAFF_SLUG,
    apiKey: `skey-${RUN_HEX}`,
    apiSecretHash: `ssecret-${RUN_HEX}`,
    channelId: `ch_ca_s_${RUN_HEX}`,
    enabled: true,
    autoRecognizeRunhqMembers: true,
    allowedOrigins: [ALLOWED_ORIGIN],
    widgetRoleClaimName: 'runhq_roles',
    widgetRolePermissions: { staff: ['assign_agent', 'live_coder', 'preview'] },
  }).returning({ id: widgetProjects.id });
  PROJECT_STAFF_ID = staff.id;
});

afterAll(async () => {
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ENABLED_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_DISABLED_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_RBAC_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_STAFF_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ENABLED_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_DISABLED_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_RBAC_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_STAFF_ID));
  await db.delete(serverMembers).where(eq(serverMembers.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, ADMIN_USER_ID));
  await db.delete(users).where(eq(users.id, MEMBER_USER_ID));
  await db.delete(users).where(eq(users.id, NON_MEMBER_USER_ID));
  await db.delete(users).where(eq(users.id, OWNER_USER_ID));
});

// Per-user tier model: every RunHQ teammate (member, admin, owner) is 'staff'
// by default on first cookie auth, so they resolve to the full staff permission
// set. The project's legacy role map is ignored entirely.
const STAFF_PERMS = ['assign_agent', 'attach_image', 'live_coder', 'preview'];

describe('authenticateWidget — Mode 0 (rw_session cookie)', () => {
  it('recognizes a workspace member on an allowlisted origin (staff by default)', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    expect(auth!.authSource).toBe('runhq');
    expect(auth!.runhqUserId).toBe(MEMBER_USER_ID);
    expect(auth!.authenticated).toBe(true);
    expect(auth!.csrfToken).toBeTruthy();
    // Teammates default to the 'staff' tier → full permission set.
    expect([...auth!.permissions].sort()).toEqual(STAFF_PERMS);
    expect(auth!.matchedRoles).toEqual([]);
  });

  it('grants the full staff permission set to a workspace admin', async () => {
    const { token } = await makeRwSession(ADMIN_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    expect(auth!.authSource).toBe('runhq');
    expect([...auth!.permissions].sort()).toEqual(STAFF_PERMS);
    expect(auth!.matchedRoles).toEqual([]);
  });

  it('grants the full staff permission set to the workspace OWNER (role=owner, is_admin=false)', async () => {
    const { token } = await makeRwSession(OWNER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    expect(auth!.authSource).toBe('runhq');
    expect([...auth!.permissions].sort()).toEqual(STAFF_PERMS);
    expect(auth!.matchedRoles).toEqual([]);
  });

  it('falls through (returns null) when the cookied user is not a workspace member', async () => {
    const { token } = await makeRwSession(NON_MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    // Cookie path didn't qualify; with no other auth headers, falls through to null.
    expect(auth).toBeNull();
  });

  it('falls through when Origin is not in allowed_origins (no leakage)', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: OTHER_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).toBeNull();
  });

  it('falls through when the project has auto-recognize OFF', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_DISABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).toBeNull();
  });

  it('falls through when the cookie value is not a valid session JWT', async () => {
    const req = buildReq({
      cookieHeader: 'rw_session=garbage.value.here',
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).toBeNull();
  });

  it('cookie wins over Authorization Bearer (precedence: runhq > app)', async () => {
    const { token: cookieToken } = await makeRwSession(MEMBER_USER_ID);
    // Bogus Bearer — would not pass JWT verification anyway, but the
    // important assertion is that the cookie path runs FIRST and wins.
    const req = buildReq({
      cookieHeader: `rw_session=${cookieToken}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmcCI6ImFueSJ9.signature',
    });
    const auth = await authenticateWidget(req);
    expect(auth?.authSource).toBe('runhq');
  });

  it('upserts a widget_users row with auth_source = "runhq" and prefixed external_user_id', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    const [row] = await db.select().from(widgetUsers).where(eq(widgetUsers.id, auth!.widgetUserId!));
    expect(row.authSource).toBe('runhq');
    expect(row.externalUserId).toBe(`runhq:${MEMBER_USER_ID}`);
  });
});

describe('authenticateWidget — CSRF protection on cookie path', () => {
  it('rejects state-changing methods without X-RunHQ-CSRF', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'POST',
    });
    const auth = await authenticateWidget(req);
    expect(auth).toBeNull();
  });

  it('rejects state-changing methods with a wrong CSRF token', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'POST',
      csrf: 'wrong-token',
    });
    const auth = await authenticateWidget(req);
    expect(auth).toBeNull();
  });

  it('accepts state-changing methods with the correct CSRF token', async () => {
    const { token, iat } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'POST',
      csrf: csrfTokenFor(MEMBER_USER_ID, iat),
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    expect(auth!.authSource).toBe('runhq');
  });

  it('does not require CSRF on safe methods (GET)', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_ENABLED_SLUG,
      method: 'GET',
      // no csrf header
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
  });
});

describe('authenticateWidget — Mode 0: tier model ignores the project role map', () => {
  // The legacy widgetRolePermissions map is no longer consulted. Regardless of
  // what a project configures, every teammate resolves to the 'staff' tier on
  // first cookie auth. These projects carry role maps purely to prove they are
  // ignored.

  it('admin on a role-mapped project still gets the full staff set (map ignored)', async () => {
    const { token } = await makeRwSession(ADMIN_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_RBAC_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    expect(auth!.authSource).toBe('runhq');
    expect([...auth!.permissions].sort()).toEqual(STAFF_PERMS);
    expect(auth!.matchedRoles).toEqual([]);
  });

  it('non-admin member also defaults to staff (map ignored)', async () => {
    const { token } = await makeRwSession(MEMBER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_RBAC_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    expect(auth!.authSource).toBe('runhq');
    expect([...auth!.permissions].sort()).toEqual(STAFF_PERMS);
    expect(auth!.matchedRoles).toEqual([]);
  });

  it('persists the staff tier + email on the upserted runhq row', async () => {
    const { token } = await makeRwSession(OWNER_USER_ID);
    const req = buildReq({
      cookieHeader: `rw_session=${token}`,
      origin: ALLOWED_ORIGIN,
      slug: PROJECT_STAFF_SLUG,
      method: 'GET',
    });
    const auth = await authenticateWidget(req);
    expect(auth).not.toBeNull();
    const [row] = await db.select().from(widgetUsers).where(eq(widgetUsers.id, auth!.widgetUserId!));
    expect(row.permissionTier).toBe('staff');
    expect(row.email).toBe(`owner+${RUN_HEX}@test.invalid`);
    expect(row.lastActiveAt).not.toBeNull();
  });
});
