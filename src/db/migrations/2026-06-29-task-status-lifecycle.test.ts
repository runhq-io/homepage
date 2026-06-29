import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(__dirname, '2026-06-29-task-status-lifecycle.sql'),
  'utf-8',
);

// Isolation: each run uses a throwaway schema with minimal pre-migration
// workspace_tasks / widget_tickets tables (status is plain TEXT, no CHECK), runs
// the migration SQL verbatim via search_path, and asserts needs_review folded to
// done while the new lifecycle values persist.

const TEST_SCHEMA = `task_status_lifecycle_test_${Math.random().toString(36).slice(2, 10)}`;

const databaseUrl = process.env.DATABASE_URL;
const describeOrSkip = databaseUrl ? describe : describe.skip;

describeOrSkip('2026-06-29 task-status-lifecycle migration', () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'task_status_lifecycle_test_%' LOOP
          EXECUTE 'DROP SCHEMA ' || quote_ident(r.nspname) || ' CASCADE';
        END LOOP;
      END
      $$;
    `);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await client.query(`SET search_path TO "${TEST_SCHEMA}"`);
  });

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    } finally {
      await client.end();
    }
  });

  beforeEach(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`SET search_path TO "${TEST_SCHEMA}"`);
    await client.query(`DROP TABLE IF EXISTS workspace_tasks CASCADE`);
    await client.query(`DROP TABLE IF EXISTS widget_tickets CASCADE`);
    await client.query(`
      CREATE TABLE workspace_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        status text NOT NULL DEFAULT 'pending'
      )
    `);
    await client.query(`
      CREATE TABLE widget_tickets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        status text NOT NULL DEFAULT 'pending'
      )
    `);
  });

  it('folds needs_review into done and leaves other statuses untouched', async () => {
    await client.query(`
      INSERT INTO workspace_tasks (title, status) VALUES
        ('a', 'needs_review'),
        ('b', 'done'),
        ('c', 'deployed'),
        ('d', 'in_progress'),
        ('e', 'cancelled')
    `);
    await client.query(`
      INSERT INTO widget_tickets (title, status) VALUES
        ('w1', 'needs_review'),
        ('w2', 'pending')
    `);

    await expect(client.query(MIGRATION)).resolves.toBeDefined();

    const tasks = await client.query(`SELECT title, status FROM workspace_tasks ORDER BY title`);
    expect(Object.fromEntries(tasks.rows.map((r: { title: string; status: string }) => [r.title, r.status]))).toEqual({
      a: 'done',
      b: 'done',
      c: 'deployed',
      d: 'in_progress',
      e: 'cancelled',
    });

    const tickets = await client.query(`SELECT title, status FROM widget_tickets ORDER BY title`);
    expect(Object.fromEntries(tickets.rows.map((r: { title: string; status: string }) => [r.title, r.status]))).toEqual({
      w1: 'done',
      w2: 'pending',
    });
  });

  it('accepts the new lifecycle values (reviewed/merged/deployed:env)', async () => {
    await client.query(`
      INSERT INTO workspace_tasks (title, status) VALUES
        ('r', 'reviewed'),
        ('m', 'merged'),
        ('p', 'deployed:11111111-2222-3333-4444-555555555555')
    `);
    await expect(client.query(MIGRATION)).resolves.toBeDefined();
    const { rows } = await client.query(`SELECT status FROM workspace_tasks ORDER BY title`);
    expect(rows.map((r: { status: string }) => r.status)).toEqual([
      'merged',
      'deployed:11111111-2222-3333-4444-555555555555',
      'reviewed',
    ]);
  });
});
