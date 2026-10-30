import { sql } from 'kysely';
import { z } from 'zod';
import type { DB } from '../../db/index.js';
import type { Proposal } from '../../db/schema.js';
import { sha256Hex } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { recordApiActivity } from '../activity/service.js';
import type { TreasuryService } from '../treasuries/service.js';

export type ProposalStatus = 'pending' | 'expired' | 'executed' | 'cancelled';

export interface MetadataInput {
  title: string;
  description: string;
  category?: string | undefined;
  externalUrl?: string | undefined;
}

/**
 * Canonical form committed to on-chain as `metadata_hash`:
 * sha256 over UTF-8 JSON with keys sorted, no whitespace, absent fields omitted.
 * The SDK implements the same function; see docs/EVENTS.md.
 */
export function canonicalMetadata(m: MetadataInput): string {
  const obj: Record<string, string> = {};
  if (m.category !== undefined) obj.category = m.category;
  obj.description = m.description;
  if (m.externalUrl !== undefined) obj.externalUrl = m.externalUrl;
  obj.title = m.title;
  return JSON.stringify(obj);
}

export const metadataHash = (m: MetadataInput) => sha256Hex(canonicalMetadata(m));

type Row = Proposal & {
  treasury_policy_version: number | null;
  meta_title: string | null;
  meta_description: string | null;
  meta_category: string | null;
  meta_external_url: string | null;
  meta_created_by: string | null;
  recipient_allowlisted: boolean;
};

const listCursor = z.tuple([z.string().regex(/^\d+$/)]);

export class ProposalService {
  constructor(
    private readonly db: DB,
    private readonly treasuries: TreasuryService,
  ) {}

  private base(contractId: string) {
    return this.db
      .selectFrom('proposals as p')
      .innerJoin('treasuries as t', 't.contract_id', 'p.contract_id')
      .leftJoin('proposal_metadata as m', (j) =>
        j.onRef('m.contract_id', '=', 'p.contract_id').onRef('m.metadata_hash', '=', 'p.metadata_hash'),
      )
      .selectAll('p')
      .select((eb) => [
        't.policy_version as treasury_policy_version',
        'm.title as meta_title',
        'm.description as meta_description',
        'm.category as meta_category',
        'm.external_url as meta_external_url',
        'm.created_by as meta_created_by',
        eb
          .exists(
            eb
              .selectFrom('treasury_recipients as r')
              .whereRef('r.contract_id', '=', 'p.contract_id')
              .whereRef('r.address', '=', 'p.recipient')
              .select('r.address'),
          )
          .as('recipient_allowlisted'),
      ])
      .where('p.contract_id', '=', contractId);
  }

  async list(
    contractId: string,
    opts: {
      status?: ProposalStatus | undefined;
      proposer?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    await this.treasuries.assertExists(contractId);
    const after = decodeCursor(opts.cursor, listCursor);
    const now = new Date();
    let q = this.base(contractId);
    switch (opts.status) {
      case 'pending':
        q = q.where('p.status', '=', 'pending').where('p.expires_at', '>', now);
        break;
      case 'expired':
        q = q.where('p.status', '=', 'pending').where('p.expires_at', '<=', now);
        break;
      case 'executed':
      case 'cancelled':
        q = q.where('p.status', '=', opts.status);
        break;
    }
    if (opts.proposer) q = q.where('p.proposer', '=', opts.proposer);
    if (after) q = q.where('p.proposal_id', '<', after[0]);
    const rows = (await q
      .orderBy('p.proposal_id', 'desc')
      .limit(opts.limit + 1)
      .execute()) as Row[];
    const page = paginate(rows, opts.limit, (r) => [r.proposal_id]);
    return { items: page.items.map((r) => toDto(r, null)), nextCursor: page.nextCursor };
  }

  async get(contractId: string, proposalId: string) {
    await this.treasuries.assertExists(contractId);
    const row = (await this.base(contractId).where('p.proposal_id', '=', proposalId).executeTakeFirst()) as
      Row | undefined;
    if (!row) throw notFound('Proposal');
    const approvals = await this.db
      .selectFrom('proposal_approvals as a')
      .leftJoin('treasury_members as mem', (j) =>
        j.onRef('mem.contract_id', '=', 'a.contract_id').onRef('mem.account', '=', 'a.approver'),
      )
      .select([
        'a.approver',
        'a.ledger',
        'a.tx_hash',
        'a.approved_at',
        sql<boolean>`mem.account IS NOT NULL`.as('is_member'),
      ])
      .where('a.contract_id', '=', contractId)
      .where('a.proposal_id', '=', proposalId)
      .orderBy('a.ledger')
      .execute();
    return toDto(
      row,
      approvals.map((a) => ({
        approver: a.approver,
        ledger: a.ledger,
        txHash: a.tx_hash,
        approvedAt: a.approved_at.toISOString(),
        approverIsMember: a.is_member,
      })),
    );
  }

  async createMetadata(account: string, contractId: string, input: MetadataInput) {
    await this.treasuries.assertMember(contractId, account);
    const hash = metadataHash(input);
    await this.db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto('proposal_metadata')
        .values({
          contract_id: contractId,
          metadata_hash: hash,
          title: input.title,
          description: input.description,
          category: input.category ?? null,
          external_url: input.externalUrl ?? null,
          created_by: account,
          created_at: new Date(),
        })
        .onConflict((oc) => oc.columns(['contract_id', 'metadata_hash']).doNothing())
        .returning('metadata_hash')
        .executeTakeFirst();
      if (inserted) {
        await recordApiActivity(tx, {
          contractId,
          type: 'proposal_metadata.created',
          actor: account,
          data: { metadataHash: hash, title: input.title },
        });
      }
    });
    return this.getMetadata(contractId, hash);
  }

  async getMetadata(contractId: string, hash: string) {
    const m = await this.db
      .selectFrom('proposal_metadata')
      .selectAll()
      .where('contract_id', '=', contractId)
      .where('metadata_hash', '=', hash)
      .executeTakeFirst();
    if (!m) throw notFound('Proposal metadata');
    return {
      metadataHash: m.metadata_hash,
      title: m.title,
      description: m.description,
      category: m.category,
      externalUrl: m.external_url,
      createdBy: m.created_by,
      createdAt: m.created_at.toISOString(),
    };
  }
}

export function computeStatus(p: Pick<Proposal, 'status' | 'expires_at'>, now = new Date()): ProposalStatus {
  if (p.status === 'pending' && p.expires_at <= now) return 'expired';
  return p.status;
}

type ApprovalDto = {
  approver: string;
  ledger: number;
  txHash: string;
  approvedAt: string;
  approverIsMember: boolean;
};

function toDto(r: Row, approvals: ApprovalDto[] | null) {
  return {
    id: r.proposal_id,
    treasuryId: r.contract_id,
    status: computeStatus(r),
    proposer: r.proposer,
    recipient: r.recipient,
    recipientAllowlisted: r.recipient_allowlisted,
    token: r.token,
    amount: r.amount,
    department: r.department,
    policyVersion: r.policy_version,
    /** Approvals made under an older policy version are invalidated on-chain. */
    policyOutdated: r.treasury_policy_version !== null && r.policy_version < r.treasury_policy_version,
    requiredApprovals: r.required_approvals,
    approvalsCount: r.approvals_count,
    ...(approvals ? { approvals } : {}),
    expiresAt: r.expires_at.toISOString(),
    created: { ledger: r.created_ledger, at: r.created_at.toISOString(), txHash: r.created_tx },
    executed: r.executed_tx
      ? { by: r.executed_by, at: r.executed_at?.toISOString() ?? null, txHash: r.executed_tx }
      : null,
    cancelled: r.cancelled_tx
      ? { by: r.cancelled_by, at: r.cancelled_at?.toISOString() ?? null, txHash: r.cancelled_tx }
      : null,
    metadataHash: r.metadata_hash,
    // Metadata is joined by content hash, so if present it matches what the proposer committed to on-chain.
    metadata:
      r.meta_title !== null
        ? {
            title: r.meta_title,
            description: r.meta_description ?? '',
            category: r.meta_category,
            externalUrl: r.meta_external_url,
            createdBy: r.meta_created_by,
            verified: true as const,
          }
        : null,
  };
}

export type ProposalDto = ReturnType<typeof toDto>;
