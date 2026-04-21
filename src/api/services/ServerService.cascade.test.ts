/**
 * Completeness test for SERVER_SCOPED_TABLES.
 *
 * This test is the safety net that prevents the original bug from ever
 * recurring: it walks the entire Drizzle schema, finds every table with a
 * foreign key targeting servers(id), and asserts that set matches
 * SERVER_SCOPED_TABLES in ServerService.ts.
 *
 * When someone adds a new child table referencing servers(id) and forgets
 * to register it in SERVER_SCOPED_TABLES, this test fails in CI — loudly
 * and before any production server deletion tries to run and crash.
 *
 * Runs with no database connection: purely schema introspection.
 */

import { describe, it, expect } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableName, is } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { SERVER_SCOPED_TABLES } from './ServerService';

function findTablesReferencingServers(): PgTable[] {
  const found: PgTable[] = [];

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;

    const config = getTableConfig(value as PgTable);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (ref.foreignTable === (schema as any).servers) {
        found.push(value as PgTable);
        break;
      }
    }
  }

  return found;
}

describe('SERVER_SCOPED_TABLES', () => {
  it('lists every table whose server_id FK would block server deletion', () => {
    const fromSchema = findTablesReferencingServers()
      .map((t) => getTableName(t))
      .sort();

    const registered = SERVER_SCOPED_TABLES
      .map((t) => getTableName(t))
      .sort();

    // If this assertion fails, a new table with a FK to servers(id) was added
    // to schema.ts without being registered in SERVER_SCOPED_TABLES (or a
    // registered table was removed). Update ServerService.ts accordingly.
    expect(registered).toEqual(fromSchema);
  });

  it('every registered table exposes a serverId column', () => {
    for (const table of SERVER_SCOPED_TABLES) {
      expect(
        (table as any).serverId,
        `Table ${getTableName(table)} is registered in SERVER_SCOPED_TABLES but has no serverId column`
      ).toBeDefined();
    }
  });
});
