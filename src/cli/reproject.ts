/**
 * Rebuilds the read model from stored raw events. Use after fixing a decoder/projector bug.
 *
 *   npm run reproject -- C...      # one treasury
 *   npm run reproject -- --all
 */
import { createDb } from '../db/index.js';
import { reprojectTreasury } from '../indexer/reproject.js';

const url = process.env.DATABASE_URL;
const target = process.argv[2];
if (!url || !target) {
  console.error('usage: DATABASE_URL=... reproject <contractId|--all>');
  process.exit(1);
}
const db = createDb({ connectionString: url, max: 2, ssl: process.env.DATABASE_SSL === 'true' });
const ids =
  target === '--all'
    ? (await db.selectFrom('treasuries').select('contract_id').execute()).map((r) => r.contract_id)
    : [target];

for (const contractId of ids) {
  const s = await reprojectTreasury(db, contractId);
  console.log(`${contractId}: replayed ${s.events} events (${s.applied} applied, ${s.invalid} invalid)`);
}
await db.destroy();
