import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(__dirname, '2026-07-02-widget-attach-image-backfill.sql'),
  'utf-8',
);

// Isolation: a throwaway schema with a minimal widget_projects table (only the
// jsonb column the migration touches), runs the migration SQL verbatim via
// search_path, and asserts the legacy attach_image derivation is materialized
// exactly where the old resolver would have derived it — and nowhere else.

const TEST_SCHEMA = `widget_attach_image_backfill_test_${Math.random().toString(36).slice(2, 10)}`;

const databaseUrl = process.env.DATABASE_URL;
const describeOrSkip = databaseUrl ? describe : describe.skip;

describeOrSkip('2026-07-02 widget-attach-image-backfill migration', () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'widget_attach_image_backfill_test_%' LOOP
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
    await client.query(`
      CREATE TABLE widget_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL,
        widget_role_permissions jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
  });

  const insert = async (slug: string, map: Record<string, string[]>) => {
    const { rows } = await client.query(
      `INSERT INTO widget_projects (slug, widget_role_permissions) VALUES ($1, $2::jsonb) RETURNING id`,
      [slug, JSON.stringify(map)],
    );
    return rows[0].id as string;
  };

  const mapOf = async (id: string): Promise<Record<string, string[]>> => {
    const { rows } = await client.query(`SELECT widget_role_permissions AS m FROM widget_projects WHERE id = $1`, [id]);
    return rows[0].m;
  };

  it('materializes attach_image onto every ticket_creator role of a legacy map', async () => {
    const id = await insert('legacy', {
      everyone: ['view_tickets'],
      logged_in: ['view_tickets', 'voter', 'ticket_creator'],
      hello: ['view_tickets', 'ticket_creator'],
      lurker: ['view_tickets'],
    });

    await expect(client.query(MIGRATION)).resolves.toBeDefined();

    expect(await mapOf(id)).toEqual({
      everyone: ['view_tickets'],
      logged_in: ['view_tickets', 'voter', 'ticket_creator', 'attach_image'],
      hello: ['view_tickets', 'ticket_creator', 'attach_image'],
      lurker: ['view_tickets'], // no ticket_creator → untouched
    });
  });

  it('leaves a map that already grants attach_image untouched (authoritative)', async () => {
    // logged_in has ticket_creator but attach_image was deliberately unchecked;
    // moderator holds attach_image explicitly, so the map is already
    // attach_image-aware and must NOT be re-derived.
    const map = {
      everyone: ['view_tickets'],
      logged_in: ['view_tickets', 'voter', 'ticket_creator'],
      moderator: ['view_tickets', 'attach_image'],
    };
    const id = await insert('authoritative', map);

    await expect(client.query(MIGRATION)).resolves.toBeDefined();

    expect(await mapOf(id)).toEqual(map);
  });

  it('does not touch legacy pre-tier or empty maps (they resolve via seeded defaults)', async () => {
    const legacyPreTier = { '*': ['attach_image'], team_member: ['assign_agent'] };
    const preTierNoAttach = { '*': ['ticket_creator'] };
    const empty = {};
    const a = await insert('pre-tier', legacyPreTier);
    const b = await insert('pre-tier-no-attach', preTierNoAttach);
    const c = await insert('empty', empty);

    await expect(client.query(MIGRATION)).resolves.toBeDefined();

    expect(await mapOf(a)).toEqual(legacyPreTier);
    expect(await mapOf(b)).toEqual(preTierNoAttach);
    expect(await mapOf(c)).toEqual(empty);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const id = await insert('legacy', {
      everyone: ['view_tickets'],
      logged_in: ['view_tickets', 'ticket_creator'],
    });
    await client.query(MIGRATION);
    const once = await mapOf(id);
    await client.query(MIGRATION);
    expect(await mapOf(id)).toEqual(once);
    expect(once.logged_in).toContain('attach_image');
  });
});
