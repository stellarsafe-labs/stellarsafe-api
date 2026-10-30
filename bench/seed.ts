/**
 * Seeds a large dataset for load testing:
 *   - 1,000 treasuries (5 members each)
 *   - one "big" treasury with 20,000 proposals and 100,000 activity rows
 * Prints the big treasury id and a member account.
 *
 *   DATABASE_URL=... npx tsx bench/seed.ts
 */
import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { sql } from 'kysely';
import { createDb } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrator.js';

const db = createDb({ connectionString: process.env.DATABASE_URL!, max: 4 });
await migrateToLatest(db);

const cid = () => StrKey.encodeContract(randomBytes(32));
const big = cid();
const member = Keypair.random().publicKey();
const ids = [big, ...Array.from({ length: 999 }, cid)];
const now = Date.now();

await db
  .insertInto('treasuries')
  .values(
    ids.map((id, i) => ({
      contract_id: id,
      network: 'testnet',
      status: 'active' as const,
      registered_by: member,
      start_ledger: 1,
      last_indexed_ledger: 1_000_000,
      policy: JSON.stringify({ version: 1, threshold: 2 }),
      policy_version: 1,
      threshold: 2,
      created_at: new Date(now - i * 1000),
    })),
  )
  .execute();

const members = ids.flatMap((id) =>
  Array.from({ length: 5 }, (_, j) => ({
    contract_id: id,
    account: id === big && j === 0 ? member : Keypair.random().publicKey(),
    role: 'member',
    added_ledger: 1,
    added_at: new Date(),
  })),
);
for (let i = 0; i < members.length; i += 1000) {
  await db
    .insertInto('treasury_members')
    .values(members.slice(i, i + 1000))
    .execute();
}

const token = cid();
await sql`
  INSERT INTO proposals (contract_id, proposal_id, proposer, recipient, token, amount, policy_version,
    required_approvals, approvals_count, status, expires_at, created_ledger, created_at, created_tx, updated_ledger)
  SELECT ${big}, g, ${member}, ${member}, ${token}, g * 1000, 1, 2, g % 3,
    (ARRAY['pending','executed','cancelled'])[1 + g % 3], now() + interval '1 day' * (g % 7 - 3),
    g, now() - interval '1 minute' * g, md5(g::text), g
  FROM generate_series(1, 20000) g
`.execute(db);

await sql`
  INSERT INTO activity (contract_id, source, type, actor, proposal_id, event_id, ledger, tx_hash, data, occurred_at)
  SELECT ${big}, 'chain',
    (ARRAY['proposal.created','proposal.approved','proposal.executed','member.added'])[1 + g % 4],
    ${member}, g % 20000 + 1, 'e' || g, g, md5(g::text), '{"seed":true}'::jsonb,
    now() - interval '1 second' * g
  FROM generate_series(1, 100000) g
`.execute(db);

await sql`ANALYZE`.execute(db);
console.log(JSON.stringify({ big, member }));
await db.destroy();
