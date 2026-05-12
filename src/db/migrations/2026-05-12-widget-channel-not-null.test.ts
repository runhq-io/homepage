import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(__dirname, '2026-05-12-widget-channel-not-null.sql'),
  'utf-8',
);

const TEST_SCHEMA = `widget_not_null_test_${Math.random().toString(36).slice(2, 10)}`;

const databaseUrl = process.env.DATABASE_URL;

const describeOrSkip = databaseUrl ? describe : describe.skip;

describeOrSkip('2026-05-12 widget-channel-not-null migration', () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'widget_not_null_test_%' LOOP
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
    await client.query(`DROP TABLE IF EXISTS widget_projects CASCADE`);
    // Post-Phase-A shape: unique index on (server_id, channel_id) exists,
    // channel_id still nullable.
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
      CREATE UNIQUE INDEX widget_projects_server_channel_unique
        ON widget_projects (server_id, channel_id)
    `);
  });

  it('enforces NOT NULL when every row has channel_id', async () => {
    await client.query(`
      INSERT INTO widget_projects (server_id, channel_id, name, slug, api_key, api_secret_hash)
      VALUES ('srv-1', 'chan-1', 'W', 'w-aaaa', 'k1', 'h1')
    `);

    await expect(client.query(MIGRATION)).resolves.toBeDefined();

    // Post-migration: inserting NULL channel_id now fails at the column constraint.
    await expect(
      client.query(`
        INSERT INTO widget_projects (server_id, channel_id, name, slug, api_key, api_secret_hash)
        VALUES ('srv-2', NULL, 'W2', 'w-bbbb', 'k2', 'h2')
      `),
    ).rejects.toThrow();
  });

  it('aborts when any row still has NULL channel_id', async () => {
    await client.query(`
      INSERT INTO widget_projects (server_id, channel_id, name, slug, api_key, api_secret_hash)
      VALUES ('srv-1', NULL, 'W', 'w-cccc', 'k3', 'h3')
    `);

    await expect(client.query(MIGRATION)).rejects.toThrow(/NULL channel_id/);

    await client.query('ROLLBACK');
    await client.query(`SET search_path TO "${TEST_SCHEMA}"`);

    // Column should still be nullable (migration rolled back).
    const { rows } = await client.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'widget_projects' AND column_name = 'channel_id'
    `, [TEST_SCHEMA]);
    expect(rows[0].is_nullable).toBe('YES');
  });
});
