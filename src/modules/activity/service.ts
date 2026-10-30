import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '../../db/index.js';
import type { Database } from '../../db/schema.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';

export interface ActivityDto {
  id: string;
  treasuryId: string;
  source: 'chain' | 'api';
  type: string;
  actor: string | null;
  proposalId: string | null;
  ledger: number | null;
  txHash: string | null;
  eventId: string | null;
  data: unknown;
  occurredAt: string;
}

export interface ActivityFilter {
  type?: string | undefined;
  actor?: string | undefined;
  source?: 'chain' | 'api' | undefined;
  proposalId?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
}

/** Records an off-chain action (metadata edits, registrations) in the treasury audit trail. */
export async function recordApiActivity(
  db: Kysely<Database>,
  entry: { contractId: string; type: string; actor: string; data?: unknown; proposalId?: string },
): Promise<void> {
  await db
    .insertInto('activity')
    .values({
      contract_id: entry.contractId,
      source: 'api',
      type: entry.type,
      actor: entry.actor,
      proposal_id: entry.proposalId ?? null,
      event_id: null,
      ledger: null,
      tx_hash: null,
      data: JSON.stringify(entry.data ?? {}),
      occurred_at: new Date(),
    })
    .execute();
}

const activityCursor = z.tuple([z.iso.datetime(), z.string().regex(/^\d+$/)]);

export class ActivityService {
  constructor(private readonly db: DB) {}

  private filtered(contractId: string, f: ActivityFilter) {
    let q = this.db.selectFrom('activity').selectAll().where('contract_id', '=', contractId);
    if (f.type)
      q = f.type.endsWith('.*')
        ? q.where('type', 'like', `${f.type.slice(0, -1).replaceAll('_', '\\_')}%`)
        : q.where('type', '=', f.type);
    if (f.actor) q = q.where('actor', '=', f.actor);
    if (f.source) q = q.where('source', '=', f.source);
    if (f.proposalId) q = q.where('proposal_id', '=', f.proposalId);
    if (f.since) q = q.where('occurred_at', '>=', new Date(f.since));
    if (f.until) q = q.where('occurred_at', '<', new Date(f.until));
    return q;
  }

  async list(contractId: string, f: ActivityFilter & { limit: number; cursor?: string | undefined }) {
    const after = decodeCursor(f.cursor, activityCursor);
    let q = this.filtered(contractId, f);
    if (after) {
      const [at, id] = after;
      q = q.where((eb) =>
        eb.or([
          eb('occurred_at', '<', new Date(at)),
          eb.and([eb('occurred_at', '=', new Date(at)), eb('id', '<', id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(f.limit + 1)
      .execute();
    const page = paginate(rows, f.limit, (r) => [r.occurred_at.toISOString(), r.id]);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async exportCsv(contractId: string, f: ActivityFilter, maxRows = 10_000): Promise<string> {
    const rows = await this.filtered(contractId, f)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .limit(maxRows)
      .execute();
    const header = [
      'occurred_at',
      'source',
      'type',
      'actor',
      'proposal_id',
      'ledger',
      'tx_hash',
      'event_id',
      'data',
    ];
    const lines = rows.map((r) =>
      [
        r.occurred_at.toISOString(),
        r.source,
        r.type,
        r.actor,
        r.proposal_id,
        r.ledger,
        r.tx_hash,
        r.event_id,
        JSON.stringify(r.data),
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\r\n') + '\r\n';
  }
}

/** RFC 4180 quoting, plus neutralising spreadsheet formula injection (=, +, -, @, tab, CR). */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n']/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toDto(r: {
  id: string;
  contract_id: string;
  source: 'chain' | 'api';
  type: string;
  actor: string | null;
  proposal_id: string | null;
  ledger: number | null;
  tx_hash: string | null;
  event_id: string | null;
  data: unknown;
  occurred_at: Date;
}): ActivityDto {
  return {
    id: r.id,
    treasuryId: r.contract_id,
    source: r.source,
    type: r.type,
    actor: r.actor,
    proposalId: r.proposal_id,
    ledger: r.ledger,
    txHash: r.tx_hash,
    eventId: r.event_id,
    data: r.data,
    occurredAt: r.occurred_at.toISOString(),
  };
}
