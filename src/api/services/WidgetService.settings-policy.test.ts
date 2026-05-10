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

describe('updateWidgetSettings — login URL gating', () => {
  it('rejects flipping is_public on without a login URL', async () => {
    // Ensure starting state: is_public false, no login URL.
    await db.update(widgetProjects)
      .set({ isPublic: false, widgetLoginUrl: null })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      is_public: true,
    })).rejects.toThrow(/login url is required/i);
  });

  it('rejects clearing the login URL while is_public stays true', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: true, widgetLoginUrl: 'https://acme.test/login' })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      login_url: null,
    })).rejects.toThrow(/login url is required/i);

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      login_url: '',
    })).rejects.toThrow(/login url is required/i);
  });

  it('rejects javascript: and other non-http schemes', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: false, widgetLoginUrl: null })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      is_public: true,
      login_url: 'javascript:alert(1)',
    })).rejects.toThrow(/valid http/i);

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      is_public: true,
      login_url: 'not a url at all',
    })).rejects.toThrow(/valid http/i);
  });

  it('persists a valid http(s) login URL and trims whitespace', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: false, widgetLoginUrl: null })
      .where(eq(widgetProjects.id, projectId));

    await WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      is_public: true,
      login_url: '  https://acme.test/login  ',
    });

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.isPublic).toBe(true);
    expect(row.widgetLoginUrl).toBe('https://acme.test/login');
  });

  it('allows clearing login URL when is_public is also being turned off', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: true, widgetLoginUrl: 'https://acme.test/login' })
      .where(eq(widgetProjects.id, projectId));

    await WidgetService.updateWidgetSettings(SERVER_ID, {
      workspaceProjectId: 'wsp_settings',
      is_public: false,
      login_url: '',
    });

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.isPublic).toBe(false);
    expect(row.widgetLoginUrl).toBeNull();
  });

  it('exposes login_url through getWidgetSettings', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: true, widgetLoginUrl: 'https://acme.test/login' })
      .where(eq(widgetProjects.id, projectId));

    const settings = await WidgetService.getWidgetSettings(SERVER_ID, 'wsp_settings');
    expect(settings).not.toBeNull();
    expect(settings!.is_public).toBe(true);
    expect(settings!.login_url).toBe('https://acme.test/login');
  });
});
