/**
 * widget-settings-rbac: Round-trip persistence of widgetRolePermissions +
 * widgetLiveCoderEnabled through getWidgetSettings / updateWidgetSettings.
 *
 * Run scoped: npx vitest run --exclude worktrees src/api/services/WidgetService.rbac-settings.test.ts
 * or by name: npx vitest run --exclude worktrees -t widget-settings-rbac
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, widgetProjects } from '../../db/schema';
import * as WidgetService from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_rbacset_${RUN_HEX}`;
const USER_ID = `00000000-00bc-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const WSP_ID = `wsp_rbacset_${RUN_HEX}`;
const LOOKUP = { workspaceProjectId: WSP_ID };
let PROJECT_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `rbac+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `RbacSet ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: WSP_ID,
    name: `RbacSet ${RUN_HEX}`,
    slug: `rbacset-${RUN_HEX}`,
    apiKey: `apikey-rbac-${RUN_HEX}`,
    apiSecretHash: `secret-rbac-${RUN_HEX}`,
    channelId: `ch_rbac_${RUN_HEX}`,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('widget-settings-rbac', () => {
  it('round-trips widgetRolePermissions and widgetLiveCoderEnabled via PUT→GET', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      widgetRolePermissions: { team_member: ['live_coder'] },
      widgetLiveCoderEnabled: true,
    }, LOOKUP);

    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings).not.toBeNull();
    expect(settings!.widgetRolePermissions).toEqual({ team_member: ['live_coder'] });
    expect(settings!.widgetLiveCoderEnabled).toBe(true);
  });

  it('leaves rbac fields untouched when not supplied', async () => {
    // Set initial state
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      widgetRolePermissions: { admin: ['assign_agent', 'live_coder'] },
      widgetLiveCoderEnabled: true,
    }, LOOKUP);
    // Update an unrelated field
    await WidgetService.updateWidgetSettings(SERVER_ID, { auto_approve: false }, LOOKUP);

    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings!.widgetRolePermissions).toEqual({ admin: ['assign_agent', 'live_coder'] });
    expect(settings!.widgetLiveCoderEnabled).toBe(true);
  });

  it('can update widgetLiveCoderEnabled independently', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, { widgetLiveCoderEnabled: false }, LOOKUP);
    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings!.widgetLiveCoderEnabled).toBe(false);
  });

  it('can update widgetRolePermissions independently', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      widgetRolePermissions: { guest: ['attach_image'] },
    }, LOOKUP);
    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings!.widgetRolePermissions).toEqual({ guest: ['attach_image'] });
  });
});
