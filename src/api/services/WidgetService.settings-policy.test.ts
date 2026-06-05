import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../db/index';
import { widgetProjects } from '../../db/schema';
import { eq } from 'drizzle-orm';
import * as WidgetService from './WidgetService';

const SERVER_ID = 'srv_settings';
const SLUG = 'settings-test';
const CHANNEL_ID = 'ch_settings';
const LOOKUP = { workspaceProjectId: 'wsp_settings' };
let projectId: string;

beforeAll(async () => {
  await db.insert(widgetProjects).values({
    serverId: SERVER_ID, workspaceProjectId: 'wsp_settings', name: 'S', slug: SLUG,
    apiKey: 'rw_settings_key', apiSecretHash: 'settings-secret-32bytes-padding-z',
    channelId: CHANNEL_ID,
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
      widgetAgentAssignmentEnabled: true,
      widgetAssignRoles: ['triager', 'pm'],
      widgetRoleClaimName: 'company_roles',
      widgetAssignRateLimitPerHour: 60,
    }, LOOKUP);
    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.widgetAgentAssignmentEnabled).toBe(true);
    expect(row.widgetAssignRoles).toEqual(['triager', 'pm']);
    expect(row.widgetRoleClaimName).toBe('company_roles');
    expect(row.widgetAssignRateLimitPerHour).toBe(60);
  });

  it('rejects empty roles when assignment is enabled', async () => {
    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      widgetAgentAssignmentEnabled: true,
      widgetAssignRoles: [],
    }, LOOKUP)).rejects.toThrow(/at least one role/i);
  });

  it('allows empty roles when assignment is disabled', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      widgetAgentAssignmentEnabled: false,
      widgetAssignRoles: [],
    }, LOOKUP);
    // No throw — pass implies success
  });

  it('exposes all four policy fields through getWidgetSettings', async () => {
    await db.update(widgetProjects)
      .set({
        widgetAgentAssignmentEnabled: true,
        widgetAssignRoles: ['triager', 'pm'],
        widgetRoleClaimName: 'company_roles',
        widgetAssignRateLimitPerHour: 60,
      })
      .where(eq(widgetProjects.id, projectId));

    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings).not.toBeNull();
    expect(settings!.widget_agent_assignment_enabled).toBe(true);
    expect(settings!.widget_assign_roles).toEqual(['triager', 'pm']);
    expect(settings!.widget_role_claim_name).toBe('company_roles');
    expect(settings!.widget_assign_rate_limit_per_hour).toBe(60);
  });
});

describe('updateWidgetSettings — login URL gating', () => {
  it('rejects flipping is_public on without a login URL', async () => {
    // Ensure starting state: is_public false, no login URL.
    await db.update(widgetProjects)
      .set({ isPublic: false, widgetLoginUrl: null })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      is_public: true,
    }, LOOKUP)).rejects.toThrow(/login url is required/i);
  });

  it('rejects clearing the login URL while is_public stays true', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: true, widgetLoginUrl: 'https://acme.test/login' })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      login_url: null,
    }, LOOKUP)).rejects.toThrow(/login url is required/i);

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      login_url: '',
    }, LOOKUP)).rejects.toThrow(/login url is required/i);
  });

  it('rejects javascript: and other non-http schemes', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: false, widgetLoginUrl: null })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      is_public: true,
      login_url: 'javascript:alert(1)',
    }, LOOKUP)).rejects.toThrow(/valid http/i);

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      is_public: true,
      login_url: 'not a url at all',
    }, LOOKUP)).rejects.toThrow(/valid http/i);
  });

  it('persists a valid http(s) login URL and trims whitespace', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: false, widgetLoginUrl: null })
      .where(eq(widgetProjects.id, projectId));

    await WidgetService.updateWidgetSettings(SERVER_ID, {
      is_public: true,
      login_url: '  https://acme.test/login  ',
    }, LOOKUP);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.isPublic).toBe(true);
    expect(row.widgetLoginUrl).toBe('https://acme.test/login');
  });

  it('allows clearing login URL when is_public is also being turned off', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: true, widgetLoginUrl: 'https://acme.test/login' })
      .where(eq(widgetProjects.id, projectId));

    await WidgetService.updateWidgetSettings(SERVER_ID, {
      is_public: false,
      login_url: '',
    }, LOOKUP);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.isPublic).toBe(false);
    expect(row.widgetLoginUrl).toBeNull();
  });

  it('exposes login_url through getWidgetSettings', async () => {
    await db.update(widgetProjects)
      .set({ isPublic: true, widgetLoginUrl: 'https://acme.test/login' })
      .where(eq(widgetProjects.id, projectId));

    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings).not.toBeNull();
    expect(settings!.is_public).toBe(true);
    expect(settings!.login_url).toBe('https://acme.test/login');
  });
});

describe('updateWidgetSettings — RunHQ-member auto-recognition', () => {
  it('rejects auto_recognize_runhq_members=true with empty allowed_origins', async () => {
    await db.update(widgetProjects)
      .set({ autoRecognizeRunhqMembers: false, allowedOrigins: [] })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      auto_recognize_runhq_members: true,
    }, LOOKUP)).rejects.toThrow(/at least one allowed origin/i);
  });

  it('rejects clearing allowed_origins while auto_recognize is on', async () => {
    await db.update(widgetProjects)
      .set({ autoRecognizeRunhqMembers: true, allowedOrigins: ['https://acme.test'] })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      allowed_origins: [],
    }, LOOKUP)).rejects.toThrow(/at least one allowed origin/i);
  });

  it('rejects malformed origins', async () => {
    await db.update(widgetProjects)
      .set({ autoRecognizeRunhqMembers: false })
      .where(eq(widgetProjects.id, projectId));

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      allowed_origins: ['not a url'],
    }, LOOKUP)).rejects.toThrow(/Invalid origin/i);

    await expect(WidgetService.updateWidgetSettings(SERVER_ID, {
      allowed_origins: ['javascript:alert(1)'],
    }, LOOKUP)).rejects.toThrow(/Invalid origin/i);
  });

  it('normalizes and deduplicates origins (lowercase host, drop default ports + paths, dedupe)', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      auto_recognize_runhq_members: true,
      allowed_origins: [
        'https://Acme.Test/login',
        'https://acme.test:443',
        'https://acme.test',
      ],
    }, LOOKUP);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.allowedOrigins).toEqual(['https://acme.test']);
    expect(row.autoRecognizeRunhqMembers).toBe(true);
  });

  it('allows clearing allowed_origins when auto_recognize is also being turned off', async () => {
    await db.update(widgetProjects)
      .set({ autoRecognizeRunhqMembers: true, allowedOrigins: ['https://acme.test'] })
      .where(eq(widgetProjects.id, projectId));

    await WidgetService.updateWidgetSettings(SERVER_ID, {
      auto_recognize_runhq_members: false,
      allowed_origins: [],
    }, LOOKUP);

    const [row] = await db.select().from(widgetProjects).where(eq(widgetProjects.id, projectId));
    expect(row.autoRecognizeRunhqMembers).toBe(false);
    expect(row.allowedOrigins).toEqual([]);
  });

  it('exposes allowed_origins and auto_recognize_runhq_members through getWidgetSettings', async () => {
    await db.update(widgetProjects)
      .set({ autoRecognizeRunhqMembers: true, allowedOrigins: ['https://acme.test', 'https://staging.acme.test'] })
      .where(eq(widgetProjects.id, projectId));

    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings).not.toBeNull();
    expect(settings!.auto_recognize_runhq_members).toBe(true);
    expect(settings!.allowed_origins).toEqual(['https://acme.test', 'https://staging.acme.test']);
  });
});
