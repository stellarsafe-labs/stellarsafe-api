import { createDb } from '../db/index.js';
import { createMigrator } from '../db/migrator.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const direction = process.argv[2] ?? 'latest';
const db = createDb({ connectionString: url, max: 1, ssl: process.env.DATABASE_SSL === 'true' });
const migrator = createMigrator(db);
const { error, results } =
  direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();
for (const r of results ?? [])
  console.log(`${r.status === 'Success' ? '✔' : '✖'} ${r.direction} ${r.migrationName}`);
if (!results?.length) console.log('No migrations to run');
await db.destroy();
if (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}
