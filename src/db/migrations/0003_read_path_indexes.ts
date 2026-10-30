import { sql, type Kysely } from 'kysely';

/**
 * Indexes found by load testing (docs/PERFORMANCE.md):
 * - pending-proposal counts were seq-scanning `proposals` once per treasury in list responses;
 * - the treasury list sorts by (created_at, contract_id).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX proposals_pending_idx ON proposals (contract_id, expires_at) WHERE status = 'pending';
    CREATE INDEX treasuries_created_idx ON treasuries (created_at DESC, contract_id DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS proposals_pending_idx, treasuries_created_idx;`.execute(db);
}
