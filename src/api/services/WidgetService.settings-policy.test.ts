import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../db/index';
import { widgetProjects } from '../../db/schema';
import { eq } from 'drizzle-orm';
import * as WidgetService from './WidgetService';

const SERVER_ID = 'srv_settings';
const SLUG = 'settings-test';
let projectId: string;

beforeAll(async () => {
  await db.insert(widgetProjects).values({
    serverId: SERVER_ID, workspaceProjectId: 'wsp_settings', name: 'S', slug: SLUG,
    apiKey: 'rw_settings_key', apiSecretHash: 'settings-secret-32bytes-padding-z',
  }).onConflictDoNothing();
  const [r] = await db.select({ id: widgetProjects.id }).from(widgetProjects).where(eq(widgetProjects.slug, SLUG));
  projectId = r.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, projectId));
});

describe('updateWidgetSettings — policy fields', () => {
  it('persists all four new policy fields together', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      widgetAgentAssignmentEnabled: true,
      widgetAssignRoles: ['triager', 'pm'],
      widgetRoleClaimName: 'company_roles',
      widgetAssignRateLimitPerHour: 60,
    });
    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.widgetAgentAssignmentEnabled).toBe(true);
    expect(row.widgetAssignRoles).toEqual(['triager', 'pm']);
    expect(row.widgetRoleClaimName).toBe('company_roles');
    expect(row.widgetAssignRateLimitPerHour).toBe(60);
  });

  it('rejects empty roles when assignment is enabled', async () => {
    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      widgetAgentAssignmentEnabled: true,
      widgetAssignRoles: [],
    })).rejects.toThrow(/at least one role/i);
  });

  it('allows empty roles when assignment is disabled', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      widgetAgentAssignmentEnabled: false,
      widgetAssignRoles: [],
    });
    // No throw — pass implies success
  });
});
