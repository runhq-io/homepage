import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { widgetProjects } from '../../db/schema';
import {
  getWidgetIntegration,
  getWidgetSettings,
  getPreviewWidgetFlag,
  generatePreviewWidgetBootstrap,
} from './WidgetService';

const RUN = randomBytes(6).toString('hex');
const SERVER = `ws_wp_${RUN}`;
const PROJ_A = `proj_test_${RUN}_a`;
const PROJ_B = `proj_test_${RUN}_b`;
const insertedIds: string[] = [];

beforeAll(async () => {
  const rows = await db.insert(widgetProjects).values([
    {
      serverId: SERVER,
      workspaceProjectId: PROJ_A,
      name: 'Moddio',
      slug: `moddio-${RUN}`,
      apiKey: `k-moddio-${RUN}`,
      apiSecretHash: `s-moddio-${RUN}`,
      enabled: true,
      autoInjectInPreview: false,
      channelId: `ch-moddio-${RUN}`,
    },
    {
      serverId: SERVER,
      workspaceProjectId: PROJ_B,
      name: 'Snek',
      slug: `snek-${RUN}`,
      apiKey: `k-snek-${RUN}`,
      apiSecretHash: `s-snek-${RUN}`,
      enabled: true,
      autoInjectInPreview: false,
      channelId: `ch-snek-${RUN}`,
    },
  ]).returning({ id: widgetProjects.id });
  insertedIds.push(...rows.map(r => r.id));
});

afterAll(async () => {
  if (insertedIds.length > 0) {
    await db.delete(widgetProjects).where(inArray(widgetProjects.id, insertedIds));
  }
});

describe('WidgetService — per-project isolation (reads)', () => {
  it('getWidgetIntegration returns the row scoped to the requested workspace project', async () => {
    const a = await getWidgetIntegration(SERVER, PROJ_A);
    const b = await getWidgetIntegration(SERVER, PROJ_B);
    expect(a?.name).toBe('Moddio');
    expect(b?.name).toBe('Snek');
  });

  it('getWidgetSettings is scoped to (serverId, workspaceProjectId)', async () => {
    const a = await getWidgetSettings(SERVER, PROJ_A);
    const b = await getWidgetSettings(SERVER, PROJ_B);
    expect(a?.slug).toBe(`moddio-${RUN}`);
    expect(b?.slug).toBe(`snek-${RUN}`);
  });

  it('getPreviewWidgetFlag is scoped to (serverId, workspaceProjectId)', async () => {
    await db.update(widgetProjects)
      .set({ autoInjectInPreview: true })
      .where(eq(widgetProjects.slug, `moddio-${RUN}`));
    const a = await getPreviewWidgetFlag(SERVER, PROJ_A);
    const b = await getPreviewWidgetFlag(SERVER, PROJ_B);
    expect(a).toEqual({ shouldInject: true, projectSlug: `moddio-${RUN}` });
    expect(b).toEqual({ shouldInject: false });
  });

  it('generatePreviewWidgetBootstrap uses the per-project row', async () => {
    // Moddio still has autoInjectInPreview=true from previous test.
    const out = await generatePreviewWidgetBootstrap(SERVER, 'user-1', 'Alice', PROJ_A);
    expect(out?.config.projectSlug).toBe(`moddio-${RUN}`);
    const none = await generatePreviewWidgetBootstrap(SERVER, 'user-1', 'Alice', PROJ_B);
    expect(none).toBeNull();
  });

  it('omitting workspaceProjectId falls back to legacy serverId-only behavior (backward compat)', async () => {
    const anyOne = await getWidgetIntegration(SERVER);
    expect(['Moddio', 'Snek']).toContain(anyOne?.name);
  });
});
