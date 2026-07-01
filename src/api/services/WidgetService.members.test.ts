import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { widgetProjects, widgetUsers } from '../../db/schema';
import { listWidgetMembers, updateWidgetMemberRole, type WidgetLookup } from './WidgetService';

// DB-backed coverage for the Members service functions (listWidgetMembers,
// updateWidgetMemberRole). Runs against the local dev Postgres.

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_mem_${RUN_HEX}`;
const OTHER_SERVER_ID = `ws_mem_other_${RUN_HEX}`;
const PROJECT_SLUG = `mem-${RUN_HEX}`;
const WORKSPACE_PROJECT_ID = `wsproj_${RUN_HEX}`;
const lookup: WidgetLookup = { workspaceProjectId: WORKSPACE_PROJECT_ID };

let projectId: string;
let otherProjectId: string;
let appUserId: string;
let staffUserId: string;
let noActivityUserId: string;

beforeAll(async () => {
  const [proj] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Mem ${RUN_HEX}`,
    slug: PROJECT_SLUG,
    apiKey: `mkey-${RUN_HEX}`,
    apiSecretHash: `msecret-${RUN_HEX}`,
    channelId: `ch_mem_${RUN_HEX}`,
    workspaceProjectId: WORKSPACE_PROJECT_ID,
    enabled: true,
  }).returning({ id: widgetProjects.id });
  projectId = proj.id;

  // A second project on a DIFFERENT server — its member must never be visible
  // or editable through the first project's lookup.
  const [other] = await db.insert(widgetProjects).values({
    serverId: OTHER_SERVER_ID,
    name: `Other ${RUN_HEX}`,
    slug: `other-${RUN_HEX}`,
    apiKey: `okey-${RUN_HEX}`,
    apiSecretHash: `osecret-${RUN_HEX}`,
    channelId: `ch_other_${RUN_HEX}`,
    workspaceProjectId: `wsproj_other_${RUN_HEX}`,
    enabled: true,
  }).returning({ id: widgetProjects.id });
  otherProjectId = other.id;

  const recent = new Date(Date.now() - 60_000);
  const older = new Date(Date.now() - 3_600_000);
  const [app] = await db.insert(widgetUsers).values({
    projectId, externalUserId: 'app-1', authSource: 'app', name: 'App One',
    email: 'app1@test.invalid', permissionTier: 'logged_in', lastActiveAt: older,
    metadata: { company: 'Acme', plan: 'pro' },
  }).returning({ id: widgetUsers.id });
  appUserId = app.id;
  const [staff] = await db.insert(widgetUsers).values({
    projectId, externalUserId: 'runhq:abc', authSource: 'runhq', name: 'Staff One',
    email: 'staff1@test.invalid', permissionTier: 'staff', lastActiveAt: recent,
  }).returning({ id: widgetUsers.id });
  staffUserId = staff.id;
  const [none] = await db.insert(widgetUsers).values({
    projectId, externalUserId: 'app-2', authSource: 'app', name: 'No Activity',
    permissionTier: 'logged_in', lastActiveAt: null,
  }).returning({ id: widgetUsers.id });
  noActivityUserId = none.id;

  await db.insert(widgetUsers).values({
    projectId: otherProjectId, externalUserId: 'foreign', authSource: 'app',
    name: 'Foreign', permissionTier: 'logged_in',
  });
});

afterAll(async () => {
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, projectId));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, otherProjectId));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, projectId));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, otherProjectId));
});

describe('listWidgetMembers', () => {
  it('returns null when the project has no widget', async () => {
    const res = await listWidgetMembers(SERVER_ID, { workspaceProjectId: 'does-not-exist' });
    expect(res).toBeNull();
  });

  it('lists only this project\'s members, ordered by activity (recent first, nulls last)', async () => {
    const res = await listWidgetMembers(SERVER_ID, lookup);
    expect(res).not.toBeNull();
    const ids = res!.map((m) => m.id);
    expect(ids).toEqual([staffUserId, appUserId, noActivityUserId]);
    // No foreign-project member leaked in.
    expect(res!.some((m) => m.name === 'Foreign')).toBe(false);
  });

  it('shapes each member with tier, email, source, and ISO timestamps', async () => {
    const res = await listWidgetMembers(SERVER_ID, lookup);
    const staff = res!.find((m) => m.id === staffUserId)!;
    expect(staff.authSource).toBe('runhq');
    expect(staff.permissionTier).toBe('staff');
    expect(staff.email).toBe('staff1@test.invalid');
    expect(typeof staff.createdAt).toBe('string');
    expect(staff.lastActiveAt).toMatch(/\dT\d/);
    const none = res!.find((m) => m.id === noActivityUserId)!;
    expect(none.lastActiveAt).toBeNull();
  });

  it('returns captured metadata, defaulting to {} when none', () => {
    return listWidgetMembers(SERVER_ID, lookup).then((res) => {
      const app = res!.find((m) => m.id === appUserId)!;
      expect(app.metadata).toEqual({ company: 'Acme', plan: 'pro' });
      const staff = res!.find((m) => m.id === staffUserId)!;
      expect(staff.metadata).toEqual({});
    });
  });
});

describe('updateWidgetMemberRole', () => {
  it('promotes an app user to staff', async () => {
    const result = await updateWidgetMemberRole(SERVER_ID, lookup, appUserId, 'staff');
    expect(result).toBe('ok');
    const [row] = await db.select().from(widgetUsers).where(eq(widgetUsers.id, appUserId));
    expect(row.permissionTier).toBe('staff');
  });

  it('returns no_project when the widget is missing', async () => {
    const result = await updateWidgetMemberRole(SERVER_ID, { workspaceProjectId: 'nope' }, appUserId, 'staff');
    expect(result).toBe('no_project');
  });

  it('returns not_found for a member that belongs to a different project', async () => {
    const [foreign] = await db.select().from(widgetUsers).where(eq(widgetUsers.projectId, otherProjectId));
    const result = await updateWidgetMemberRole(SERVER_ID, lookup, foreign.id, 'staff');
    expect(result).toBe('not_found');
    // And the foreign row is untouched.
    const [still] = await db.select().from(widgetUsers).where(eq(widgetUsers.id, foreign.id));
    expect(still.permissionTier).toBe('logged_in');
  });

  it('returns not_found for an unknown member id', async () => {
    const result = await updateWidgetMemberRole(SERVER_ID, lookup, '00000000-0000-4000-a000-000000000000', 'staff');
    expect(result).toBe('not_found');
  });
});
