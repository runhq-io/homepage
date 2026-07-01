/**
 * WidgetService.milestones-detail.test.ts — integration coverage for the
 * partner-facing milestone model and the code-safe linkedPr trim in
 * getPublicTicketDetail.
 *
 * Self-contained setup: this suite sets channelId on its widget project (and a
 * matching workspaceChannelId on its tasks) so it runs correctly regardless of
 * whether the scratch DB has widget_projects.channel_id nullable or NOT NULL —
 * a parallel branch's migration has, at times, flipped that column on the
 * shared scratch Postgres. Setting a real value for a real (nullable) column is
 * always legal and exercises the channel-scoped query path.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskActivity, widgetProjects, widgetUsers } from '../../db/schema';
import { getPublicTicketDetail } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_ms_test_${RUN_HEX}`;
const USER_ID = `00000000-0005-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-${RUN_HEX}`;
let PROJECT_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Milestones ${RUN_HEX}`,
    slug: `milestones-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`,
    apiSecretHash: `secret-${RUN_HEX}`,
    channelId: CHANNEL_ID,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  await db.insert(widgetUsers).values({
    projectId: PROJECT_ID,
    externalUserId: `ext-${RUN_HEX}`,
    name: 'Alice',
  });
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function makeTask(status: string) {
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    workspaceChannelId: CHANNEL_ID,
    title: `Task ${status}`,
    visibility: 'public',
    status: status as any,
  }).returning({ id: workspaceTasks.id });
  return task!.id;
}

describe('getPublicTicketDetail — milestones', () => {
  it('includes a server-derived milestone stepper', async () => {
    const id = await makeTask('in_progress');
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id);
      expect(detail).not.toBeNull();
      expect(Array.isArray(detail!.milestones)).toBe(true);
      const keys = detail!.milestones.map((m) => m.key);
      expect(keys).toEqual(['received', 'in_progress', 'in_review', 'reviewed', 'merged', 'deployed']);
      expect(detail!.milestones.find((m) => m.key === 'in_progress')!.state).toBe('current');
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('deployed status marks every milestone done', async () => {
    const id = await makeTask('deployed');
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id);
      const deployed = detail!.milestones.find((m) => m.key === 'deployed');
      expect(deployed!.state).toBe('done');
      expect(detail!.milestones.every((m) => m.state === 'done')).toBe(true);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('resolves a deployed:<env> status to a "Deployed → <name>" label from the project env map', async () => {
    const ENV_ID = `env-${RUN_HEX}`;
    await db.update(widgetProjects)
      .set({ deployEnvironments: [{ id: ENV_ID, name: 'production' }] })
      .where(eq(widgetProjects.id, PROJECT_ID));
    const id = await makeTask(`deployed:${ENV_ID}`);
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id);
      const deployed = detail!.milestones.find((m) => m.key === 'deployed');
      expect(deployed!.label).toBe('Deployed → production');
      expect(deployed!.state).toBe('done');
      // The raw env id must never surface in the partner-facing label.
      expect(deployed!.label).not.toContain(ENV_ID);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
      await db.update(widgetProjects).set({ deployEnvironments: null }).where(eq(widgetProjects.id, PROJECT_ID));
    }
  });

  it('a linked PR exposes ONLY state — never number/url/branch — and advances to In review', async () => {
    const id = await makeTask('in_progress');
    await db.insert(workspaceTaskActivity).values({
      serverId: SERVER_ID,
      taskId: id,
      type: 'pr_linked',
      createdByType: 'system',
      metadata: { number: 99, url: 'https://github.com/acme/web/pull/99', state: 'open', repoBranch: 'session/job/ticket' },
    });
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id);
      expect(detail!.linkedPr).toEqual({ state: 'open' });
      // Code-safety: the internal locators must NOT leak to the partner.
      const serialized = JSON.stringify(detail!.linkedPr);
      expect(serialized).not.toContain('99');
      expect(serialized).not.toContain('github.com');
      expect(serialized).not.toContain('session/job');
      expect(detail!.milestones.find((m) => m.key === 'in_review')!.state).toBe('current');
      // The activity feed must NOT leak the PR locators either — only state.
      const prActivity = detail!.activity.find((a) => a.type === 'pr_linked');
      expect(prActivity).toBeTruthy();
      expect(prActivity!.metadata).toEqual({ state: 'open' });
      const activitySerialized = JSON.stringify(detail!.activity);
      expect(activitySerialized).not.toContain('github.com');
      expect(activitySerialized).not.toContain('session/job');
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });
});
