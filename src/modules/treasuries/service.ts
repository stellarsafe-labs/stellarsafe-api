import type { ChainClient } from '../../chain/chain-client.js';
import type { Config } from '../../config.js';
import type { DB } from '../../db/index.js';
import type { Treasury } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { recordApiActivity } from '../activity/service.js';
import { z } from 'zod';

export interface TreasuryDto {
  id: string;
  network: string;
  name: string | null;
  description: string | null;
  status: 'pending' | 'active';
  wasmHash: string | null;
  admin: string | null;
  policy: Record<string, unknown> | null;
  policyVersion: number | null;
  threshold: number | null;
  memberCount: number;
  pendingProposalCount: number;
  initializedAt: string | null;
  initializedLedger: number | null;
  registeredBy: string;
  createdAt: string;
  indexing: { startLedger: number; lastIndexedLedger: number; historyComplete: boolean };
}

type TreasuryRow = Treasury & { member_count: string | number; pending_count: string | number };

const listCursor = z.tuple([z.iso.datetime(), z.string()]);

export class TreasuryService {
  constructor(
    private readonly db: DB,
    private readonly chain: ChainClient,
    private readonly config: Config,
  ) {}

  private baseQuery() {
    return this.db
      .selectFrom('treasuries as t')
      .selectAll('t')
      .select((eb) => [
        eb
          .selectFrom('treasury_members as m')
          .whereRef('m.contract_id', '=', 't.contract_id')
          .select(eb.fn.countAll().as('c'))
          .as('member_count'),
        eb
          .selectFrom('proposals as p')
          .whereRef('p.contract_id', '=', 't.contract_id')
          .where('p.status', '=', 'pending')
          .where('p.expires_at', '>', new Date())
          .select(eb.fn.countAll().as('c'))
          .as('pending_count'),
      ]);
  }

  async list(opts: {
    member?: string | undefined;
    status?: 'pending' | 'active' | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const after = decodeCursor(opts.cursor, listCursor);
    let q = this.baseQuery();
    if (opts.member) {
      const member = opts.member;
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('treasury_members as mm')
            .whereRef('mm.contract_id', '=', 't.contract_id')
            .where('mm.account', '=', member)
            .select('mm.account'),
        ),
      );
    }
    if (opts.status) q = q.where('t.status', '=', opts.status);
    if (after) {
      const [createdAt, id] = after;
      q = q.where((eb) =>
        eb.or([
          eb('t.created_at', '<', new Date(createdAt)),
          eb.and([eb('t.created_at', '=', new Date(createdAt)), eb('t.contract_id', '<', id)]),
        ]),
      );
    }
    const rows = (await q
      .orderBy('t.created_at', 'desc')
      .orderBy('t.contract_id', 'desc')
      .limit(opts.limit + 1)
      .execute()) as TreasuryRow[];
    const page = paginate(rows, opts.limit, (r) => [r.created_at.toISOString(), r.contract_id]);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async get(contractId: string): Promise<TreasuryDto> {
    const row = (await this.baseQuery().where('t.contract_id', '=', contractId).executeTakeFirst()) as
      TreasuryRow | undefined;
    if (!row) throw notFound('Treasury');
    return toDto(row);
  }

  async assertExists(contractId: string): Promise<Treasury> {
    const row = await this.db
      .selectFrom('treasuries')
      .selectAll()
      .where('contract_id', '=', contractId)
      .executeTakeFirst();
    if (!row) throw notFound('Treasury');
    return row;
  }

  async isMember(contractId: string, account: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('treasury_members')
      .select('account')
      .where('contract_id', '=', contractId)
      .where('account', '=', account)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Off-chain writes are only allowed for accounts that are members according to indexed chain state. */
  async assertMember(contractId: string, account: string): Promise<void> {
    await this.assertExists(contractId);
    if (!(await this.isMember(contractId, account))) {
      throw forbidden('Only treasury members (per on-chain state) can perform this action');
    }
  }

  async register(
    account: string,
    input: {
      contractId: string;
      startLedger?: number | undefined;
      name?: string | undefined;
      description?: string | undefined;
    },
  ): Promise<TreasuryDto> {
    const existing = await this.db
      .selectFrom('treasuries')
      .select('contract_id')
      .where('contract_id', '=', input.contractId)
      .executeTakeFirst();
    if (existing) throw conflict('Treasury is already registered');

    const wasmHash = await this.chain.getContractWasmHash(input.contractId);
    if (wasmHash === null) throw unprocessable(`Contract not found on ${this.config.STELLAR_NETWORK}`);
    if (wasmHash === 'stellar_asset')
      throw unprocessable('Contract is a Stellar Asset Contract, not a treasury');
    const trusted = this.config.TRUSTED_WASM_HASHES;
    if (trusted.length > 0 && !trusted.includes(wasmHash)) {
      throw unprocessable('Contract code is not a trusted StellarSafe treasury build', { wasmHash });
    }

    const { latestLedger, oldestLedger } = await this.chain.getLedgerBounds();
    const startLedger = input.startLedger ?? oldestLedger;
    if (startLedger > latestLedger)
      throw badRequest(`startLedger is ahead of the network tip (${latestLedger})`);

    await this.db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto('treasuries')
        .values({
          contract_id: input.contractId,
          network: this.config.STELLAR_NETWORK,
          name: input.name ?? null,
          description: input.description ?? null,
          status: 'pending',
          wasm_hash: wasmHash,
          registered_by: account,
          start_ledger: startLedger,
          last_indexed_ledger: startLedger - 1,
          // Millisecond precision keeps (created_at, id) cursors exact.
          created_at: new Date(),
        })
        .onConflict((oc) => oc.column('contract_id').doNothing())
        .returning('contract_id')
        .executeTakeFirst();
      if (!inserted) throw conflict('Treasury is already registered');
      await recordApiActivity(tx, {
        contractId: input.contractId,
        type: 'treasury.registered',
        actor: account,
        data: { startLedger, wasmHash },
      });
    });
    return this.get(input.contractId);
  }

  async updateMetadata(
    account: string,
    contractId: string,
    input: { name?: string | null | undefined; description?: string | null | undefined },
  ): Promise<TreasuryDto> {
    await this.assertMember(contractId, account);
    const changes: { name?: string | null; description?: string | null } = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.description !== undefined) changes.description = input.description;
    if (Object.keys(changes).length === 0) throw badRequest('Nothing to update');

    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('treasuries')
        .set({ ...changes, updated_at: new Date() })
        .where('contract_id', '=', contractId)
        .execute();
      await recordApiActivity(tx, {
        contractId,
        type: 'treasury.metadata_updated',
        actor: account,
        data: changes,
      });
    });
    return this.get(contractId);
  }

  async members(contractId: string) {
    await this.assertExists(contractId);
    const rows = await this.db
      .selectFrom('treasury_members')
      .selectAll()
      .where('contract_id', '=', contractId)
      .orderBy('added_ledger')
      .orderBy('account')
      .execute();
    return rows.map((r) => ({
      account: r.account,
      role: r.role,
      addedLedger: r.added_ledger,
      addedAt: r.added_at.toISOString(),
    }));
  }

  async recipients(contractId: string) {
    await this.assertExists(contractId);
    const rows = await this.db
      .selectFrom('treasury_recipients')
      .selectAll()
      .where('contract_id', '=', contractId)
      .orderBy('added_ledger')
      .orderBy('address')
      .execute();
    return rows.map((r) => ({
      address: r.address,
      label: r.label,
      addedLedger: r.added_ledger,
      addedAt: r.added_at.toISOString(),
    }));
  }

  /** Live balances read from chain (not the index). Tokens default to every token the treasury has proposed. */
  async balances(contractId: string, tokens: string[] = []) {
    await this.assertExists(contractId);
    const known = await this.db
      .selectFrom('proposals')
      .select('token')
      .distinct()
      .where('contract_id', '=', contractId)
      .limit(20)
      .execute();
    const all = [...new Set([...tokens, ...known.map((k) => k.token)])].slice(0, 20);
    const balances = await Promise.all(
      all.map(async (token) => {
        try {
          return { token, balance: await this.chain.getTokenBalance(token, contractId) };
        } catch {
          return { token, balance: null };
        }
      }),
    );
    const { latestLedger } = await this.chain.getLedgerBounds();
    return { treasuryId: contractId, ledger: latestLedger, balances };
  }
}

function toDto(r: TreasuryRow): TreasuryDto {
  return {
    id: r.contract_id,
    network: r.network,
    name: r.name,
    description: r.description,
    status: r.status,
    wasmHash: r.wasm_hash,
    admin: r.admin,
    policy: (r.policy as Record<string, unknown> | null) ?? null,
    policyVersion: r.policy_version,
    threshold: r.threshold,
    memberCount: Number(r.member_count),
    pendingProposalCount: Number(r.pending_count),
    initializedAt: r.initialized_at?.toISOString() ?? null,
    initializedLedger: r.initialized_ledger,
    registeredBy: r.registered_by,
    createdAt: r.created_at.toISOString(),
    indexing: {
      startLedger: r.start_ledger,
      lastIndexedLedger: r.last_indexed_ledger,
      historyComplete: r.history_complete,
    },
  };
}
