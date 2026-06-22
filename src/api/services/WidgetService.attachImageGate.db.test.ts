/**
 * DB-backed tests for `canAttachImages` — the request-time wrapper that loads a
 * project's widgetRolePermissions map and applies the opt-in attach_image gate.
 *
 * Uses a real Postgres test DB (configured via .env DATABASE_URL), mirroring
 * WidgetService.rbac.test.ts.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../db/index.js';
import { widgetProjects } from '../../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { canAttachImages } from './WidgetService.js';

const GATED_SLUG = 'attach-gate-gated';
const OPEN_SLUG = 'attach-gate-open';
const perms = (...keys: string[]) => new Set(keys) as ReadonlySet<any>;

let gatedId = '';
let openId = '';

const base = {
  serverId: 'srv_attach_gate',
  enabled: true,
  isPublic: false,
  widgetAgentAssignmentEnabled: false,
  widgetAssignRoles: [] as string[],
  widgetRoleClaimName: 'runhq_roles',
};

beforeAll(async () => {
  await db.insert(widgetProjects).values([
    {
      ...base,
      workspaceProjectId: 'wsp_attach_gated', name: 'Gated', slug: GATED_SLUG,
      apiKey: 'pk_attach_gated', apiSecretHash: 'shh_gated', channelId: 'ch_gated',
      // attach_image is granted to a specific role → gate is "configured".
      widgetRolePermissions: { staff: ['attach_image'] },
    },
    {
      ...base,
      workspaceProjectId: 'wsp_attach_open', name: 'Open', slug: OPEN_SLUG,
      apiKey: 'pk_attach_open', apiSecretHash: 'shh_open', channelId: 'ch_open',
      // attach_image not granted anywhere → opt-in gate stays open.
      widgetRolePermissions: { staff: ['assign_agent'] },
    },
  ]).onConflictDoNothing();
  const rows = await db.select({ id: widgetProjects.id, slug: widgetProjects.slug })
    .from(widgetProjects)
    .where(inArray(widgetProjects.slug, [GATED_SLUG, OPEN_SLUG]));
  gatedId = rows.find(r => r.slug === GATED_SLUG)!.id;
  openId = rows.find(r => r.slug === OPEN_SLUG)!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(inArray(widgetProjects.id, [gatedId, openId]));
});

describe('canAttachImages (request-time gate)', () => {
  it('permits a user with attach_image on a configured project', async () => {
    expect(await canAttachImages(gatedId, perms('attach_image'))).toBe(true);
  });

  it('denies a user without attach_image on a configured project', async () => {
    expect(await canAttachImages(gatedId, perms('assign_agent'))).toBe(false);
  });

  it('permits any user on a project that does not configure attach_image', async () => {
    expect(await canAttachImages(openId, perms())).toBe(true);
  });

  it('permits when the project row is missing (fails open, like back-compat)', async () => {
    // A valid-format UUID that doesn't exist (e.g. project deleted mid-request).
    // auth.projectId is always a real UUID, so this is the realistic edge.
    expect(await canAttachImages('00000000-0000-0000-0000-000000000000', perms())).toBe(true);
  });
});
