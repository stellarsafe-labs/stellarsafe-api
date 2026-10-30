import { xdr } from '@stellar/stellar-sdk';
import type { DB } from '../db/index.js';
import { decodeEvent } from './decoder.js';
import { projectEvent } from './projector.js';

export interface ReprojectStats {
  events: number;
  applied: number;
  invalid: number;
}

/**
 * Rebuilds one treasury's read model by replaying its stored raw events through the current
 * decoder and projector, in a single transaction. Off-chain data (names, proposal metadata,
 * API audit entries, subscriptions) is kept, and no notifications are re-sent.
 */
export async function reprojectTreasury(db: DB, contractId: string): Promise<ReprojectStats> {
  return db.transaction().execute(async (tx) => {
    await tx.deleteFrom('proposals').where('contract_id', '=', contractId).execute();
    await tx.deleteFrom('treasury_members').where('contract_id', '=', contractId).execute();
    await tx.deleteFrom('treasury_recipients').where('contract_id', '=', contractId).execute();
    await tx
      .deleteFrom('activity')
      .where('contract_id', '=', contractId)
      .where('source', '=', 'chain')
      .execute();
    await tx
      .updateTable('treasuries')
      .set({
        status: 'pending',
        policy: null,
        policy_version: null,
        threshold: null,
        admin: null,
        initialized_at: null,
        initialized_ledger: null,
        updated_at: new Date(),
      })
      .where('contract_id', '=', contractId)
      .execute();

    const events = await tx
      .selectFrom('chain_events')
      .selectAll()
      .where('contract_id', '=', contractId)
      .orderBy('id')
      .execute();

    const stats: ReprojectStats = { events: events.length, applied: 0, invalid: 0 };
    for (const e of events) {
      const decoded = decodeEvent({
        topic: e.topic_xdr.map((t) => xdr.ScVal.fromXdr(t, 'base64')),
        value: xdr.ScVal.fromXdr(e.value_xdr, 'base64'),
      });
      await tx
        .updateTable('chain_events')
        .set({
          decode_error: decoded.ok ? null : decoded.error,
          event_type: decoded.ok ? decoded.event.name : decoded.name,
        })
        .where('id', '=', e.id)
        .execute();
      if (!decoded.ok) {
        stats.invalid++;
        continue;
      }
      await projectEvent(
        tx,
        { eventId: e.id, contractId, ledger: e.ledger, occurredAt: e.ledger_closed_at, txHash: e.tx_hash },
        decoded.event,
        { notify: false },
      );
      stats.applied++;
    }
    return stats;
  });
}
