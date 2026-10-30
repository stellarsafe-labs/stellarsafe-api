import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';
import * as m0001 from './migrations/0001_initial.js';

/** Migrations are registered statically so they work identically from `tsx` and compiled `dist/`. */
const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are schema-agnostic
export function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({ db, provider });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateToLatest(db: Kysely<any>): Promise<MigrationResultSet> {
  const result = await createMigrator(db).migrateToLatest();
  if (result.error)
    throw result.error instanceof Error ? result.error : new Error(JSON.stringify(result.error));
  return result;
}
