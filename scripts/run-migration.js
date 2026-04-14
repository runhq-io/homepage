import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../src/db/migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

function listMigrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function ensureMigrationsTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadAppliedMigrations() {
  const result = await client.query('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((row) => row.name));
}

async function applyMigration(filename) {
  const fullPath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(fullPath, 'utf8').trim();
  if (!sql) {
    console.log(`[migrate] skipping empty migration ${filename}`);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [filename]);
    return;
  }

  console.log(`[migrate] applying ${filename}`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  await client.connect();
  await ensureMigrationsTable();

  const files = listMigrationFiles();
  const applied = await loadAppliedMigrations();
  const pending = files.filter((file) => !applied.has(file));

  if (pending.length === 0) {
    console.log('[migrate] no pending migrations');
    return;
  }

  for (const file of pending) {
    await applyMigration(file);
  }

  console.log(`[migrate] applied ${pending.length} migration(s)`);
}

main()
  .catch((error) => {
    console.error('[migrate] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => {});
  });
