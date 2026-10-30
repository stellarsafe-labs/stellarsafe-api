import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;

export interface DbOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
  applicationName?: string;
}

export function createDb(opts: DbOptions): DB {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
    application_name: opts.applicationName ?? 'stellarsafe-api',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
