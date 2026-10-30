import { sql } from 'kysely';
import type { ChainClient } from '../chain/chain-client.js';
import type { DB } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import { indexerErrors, indexerEvents, indexerLag } from '../lib/metrics.js';
import { decodeEvent, type RawContractEvent } from './decoder.js';
import { projectEvent } from './projector.js';

/** Advisory lock id serialising event application across indexer replicas. */
const INDEXER_LOCK_ID = 0x5354_4c53; // "STLS"

export interface IndexerOptions {
  windowLedgers: number;
  pollIntervalMs: number;
  /** Max distinct checkpoint groups processed per tick (bounds work per tick during backfills). */
  maxGroupsPerTick?: number;
}

export interface TickResult {
  latestLedger: number;
  groups: number;
  eventsIngested: number;
  /** True when some treasury is still behind the tip, so the next tick should run immediately. */
  behind: boolean;
}

/**
 * Pulls StellarSafe contract events from Soroban RPC and projects them into Postgres.
 *
 * Each treasury keeps its own checkpoint (`last_indexed_ledger`). Treasuries sharing a checkpoint
 * are fetched together; a freshly registered treasury backfills in its own group until it catches
 * up and merges with the rest. Raw events, projections and checkpoints commit in one transaction,
 * and checkpoints advance with compare-and-set, so a crash or a second indexer replica can never
 * skip or double-apply events. Stellar has deterministic finality, so there are no reorgs to undo.
 */
export class Indexer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private consecutiveFailures = 0;

  constructor(
    private readonly db: DB,
    private readonly chain: ChainClient,
    private readonly log: Logger,
    private readonly opts: IndexerOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
    this.log.info({ windowLedgers: this.opts.windowLedgers }, 'indexer started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 25));
    this.log.info('indexer stopped');
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), delayMs);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    this.running = true;
    let delay = this.opts.pollIntervalMs;
    try {
      const result = await this.tick();
      this.consecutiveFailures = 0;
      if (result.behind) delay = 0;
    } catch (err) {
      this.consecutiveFailures++;
      indexerErrors.inc();
      delay = Math.min(this.opts.pollIntervalMs * 2 ** this.consecutiveFailures, 60_000);
      this.log.error({ err, retryInMs: delay }, 'indexer tick failed');
    } finally {
      this.running = false;
    }
    this.schedule(delay);
  }

  async tick(): Promise<TickResult> {
    const { latestLedger, oldestLedger } = await this.chain.getLedgerBounds();
    await this.skipExpiredHistory(oldestLedger);

    const pending = await this.db
      .selectFrom('treasuries')
      .select(['contract_id', 'last_indexed_ledger'])
      .where('last_indexed_ledger', '<', latestLedger)
      .orderBy('last_indexed_ledger')
      .execute();

    const minIndexed = pending[0]?.last_indexed_ledger ?? latestLedger;
    indexerLag.set(latestLedger - minIndexed);

    const groups = new Map<number, string[]>();
    for (const t of pending) {
      const ids = groups.get(t.last_indexed_ledger) ?? [];
      ids.push(t.contract_id);
      groups.set(t.last_indexed_ledger, ids);
    }

    let eventsIngested = 0;
    let processed = 0;
    for (const [checkpoint, ids] of groups) {
      if (processed++ >= (this.opts.maxGroupsPerTick ?? 10)) break;
      const start = checkpoint + 1;
      const end = Math.min(checkpoint + this.opts.windowLedgers, latestLedger);
      const events = await this.chain.getContractEvents(ids, start, end);
      eventsIngested += await this.apply(ids, checkpoint, end, events);
    }

    const behind = await this.db
      .selectFrom('treasuries')
      .select('contract_id')
      .where('last_indexed_ledger', '<', latestLedger)
      .limit(1)
      .executeTakeFirst();

    return { latestLedger, groups: groups.size, eventsIngested, behind: behind !== undefined };
  }

  /** RPC nodes only retain recent history. Jump treasuries past the gap and flag them. */
  private async skipExpiredHistory(oldestLedger: number): Promise<void> {
    const skipped = await this.db
      .updateTable('treasuries')
      .set({ last_indexed_ledger: oldestLedger - 1, history_complete: false, updated_at: new Date() })
      .where('last_indexed_ledger', '<', oldestLedger - 1)
      .returning(['contract_id', 'last_indexed_ledger'])
      .execute();
    for (const t of skipped) {
      this.log.warn(
        { contractId: t.contract_id, resumedAt: oldestLedger },
        'treasury history is older than RPC retention; some events were not indexed',
      );
    }
  }

  private async apply(ids: string[], checkpoint: number, end: number, events: RawContractEvent[]) {
    return this.db.transaction().execute(async (tx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(${INDEXER_LOCK_ID}) AS locked`.execute(tx);
      if (!lock.rows[0]?.locked) return 0;

      // Compare-and-set: only treasuries still at `checkpoint` are advanced and applied.
      const claimed = await tx
        .updateTable('treasuries')
        .set({ last_indexed_ledger: end, updated_at: new Date() })
        .where('contract_id', 'in', ids)
        .where('last_indexed_ledger', '=', checkpoint)
        .returning('contract_id')
        .execute();
      const owned = new Set(claimed.map((c) => c.contract_id));

      let ingested = 0;
      for (const raw of events) {
        if (!owned.has(raw.contractId)) continue;
        const decoded = decodeEvent(raw);
        const inserted = await tx
          .insertInto('chain_events')
          .values({
            id: raw.id,
            contract_id: raw.contractId,
            ledger: raw.ledger,
            ledger_closed_at: new Date(raw.ledgerClosedAt),
            tx_hash: raw.txHash,
            event_type: decoded.ok ? decoded.event.name : decoded.name,
            topic_xdr: raw.topic.map((t) => t.toXdr('base64')),
            value_xdr: raw.value.toXdr('base64'),
            decode_error: decoded.ok ? null : decoded.error,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!inserted) {
          indexerEvents.inc({ result: 'duplicate' });
          continue;
        }
        ingested++;

        if (!decoded.ok) {
          indexerEvents.inc({ result: decoded.ignorable ? 'ignored' : 'invalid' });
          if (!decoded.ignorable) {
            this.log.error(
              { eventId: raw.id, contractId: raw.contractId, error: decoded.error },
              'invalid event',
            );
          }
          continue;
        }

        const outcome = await projectEvent(
          tx,
          {
            eventId: raw.id,
            contractId: raw.contractId,
            ledger: raw.ledger,
            occurredAt: new Date(raw.ledgerClosedAt),
            txHash: raw.txHash,
          },
          decoded.event,
        );
        indexerEvents.inc({ result: outcome.applied ? 'applied' : 'partial' });
        if (outcome.warning)
          this.log.warn({ eventId: raw.id, warning: outcome.warning }, 'partial projection');
      }
      return ingested;
    });
  }
}
