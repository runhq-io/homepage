import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(__dirname, '2026-05-11-widget-per-channel.sql'),
  'utf-8',
);

// Isolation strategy:
//   The migration mutates table-level constraints on widget_projects (drops one
//   unique index, creates another). Running it directly against the dev `public`
//   schema would clobber state shared with other tests and any local data.
//
//   Instead, each test creates a throwaway schema, recreates a minimal
//   pre-migration widget_projects table inside it, applies the migration SQL
//   with `search_path` pointing at the throwaway schema, asserts the post-
//   migration invariants, and drops the schema in afterAll. Unqualified table
//   names inside the migration resolve via search_path, so the migration file
//   itself is exercised verbatim.
//
//   A single dedicated `pg.Client` is used so `SET search_path` and BEGIN/COMMIT
//   in the migration stay on the same connection.

const TEST_SCHEMA = `widget_per_channel_test_${Math.random().toString(36).slice(2, 10)}`;

const databaseUrl = process.env.DATABASE_URL;

const describeOrSkip = databaseUrl ? describe : describe.skip;

describeOrSkip('2026-05-11 widget-per-channel migration', () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    // Sweep any leftover schemas from crashed prior runs.
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'widget_per_channel_test_%' LOOP
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

    // Reset the schema to pre-migration shape.
    await client.query(`SET search_path TO "${TEST_SCHEMA}"`);
    await client.query(`DROP TABLE IF EXISTS widget_projects CASCADE`);
    await client.query(`
      CREATE TABLE widget_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id text NOT NULL,
        workspace_project_id text,
        channel_id text,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        api_key text NOT NULL UNIQUE,
        api_secret_hash text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX widget_projects_server_workspace_project_unique
        ON widget_projects (server_id, workspace_project_id)
        WHERE workspace_project_id IS NOT NULL
    `);
  });

  it('swaps the unique index when all rows already have channel_id', async () => {
    await client.query(`
      INSERT INTO widget_projects (server_id, workspace_project_id, channel_id, name, slug, api_key, api_secret_hash)
      VALUES ('srv-1', 'proj-1', 'chan-1', 'W', 'w-aaaa', 'k1', 'h1')
    `);

    await expect(client.query(MIGRATION)).resolves.toBeDefined();

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'widget_projects'`,
      [TEST_SCHEMA],
    );
    const names = idx.rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain('widget_projects_server_channel_unique');
    expect(names).not.toContain('widget_projects_server_workspace_project_unique');
  });

  it('runs safely when channel_id is still NULL (deferred-NOT-NULL phase)', async () => {
    // This phase of the rollout: the workspace reconciler has not yet
    // populated channel_id on legacy rows. Postgres treats NULLs as distinct
    // in unique indexes, so creating the new index over NULL rows is safe.
    // The NOT NULL constraint is intentionally deferred to a follow-up
    // migration added to the repo after backfill is verified.
    await client.query(`
      INSERT INTO widget_projects (server_id, workspace_project_id, channel_id, name, slug, api_key, api_secret_hash)
      VALUES ('srv-1', 'proj-1', NULL, 'W', 'w-cccc', 'k3', 'h3')
    `);
    await client.query(`
      INSERT INTO widget_projects (server_id, workspace_project_id, channel_id, name, slug, api_key, api_secret_hash)
      VALUES ('srv-1', 'proj-2', NULL, 'W2', 'w-cccd', 'k3b', 'h3b')
    `);

    await expect(client.query(MIGRATION)).resolves.toBeDefined();

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'widget_projects'`,
      [TEST_SCHEMA],
    );
    const names = idx.rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain('widget_projects_server_channel_unique');
    expect(names).not.toContain('widget_projects_server_workspace_project_unique');

    // Both NULL rows remain (NULLs are distinct in unique indexes).
    const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM widget_projects`);
    expect(rows[0].c).toBe(2);
  });

  it('rejects duplicate (server_id, channel_id) after migration', async () => {
    await client.query(`
      INSERT INTO widget_projects (server_id, workspace_project_id, channel_id, name, slug, api_key, api_secret_hash)
      VALUES ('srv-1', 'proj-1', 'chan-1', 'W', 'w-dddd', 'k4', 'h4')
    `);
    await client.query(MIGRATION);

    await expect(
      client.query(`
        INSERT INTO widget_projects (server_id, workspace_project_id, channel_id, name, slug, api_key, api_secret_hash)
        VALUES ('srv-1', 'proj-2', 'chan-1', 'W2', 'w-eeee', 'k5', 'h5')
      `),
    ).rejects.toThrow(/widget_projects_server_channel_unique/);
  });
});
