import type { Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { DOMAIN_EVENT_TYPES, type DecodedBody } from './decoder.js';

export interface EventContext {
  eventId: string;
  contractId: string;
  ledger: number;
  occurredAt: Date;
  txHash: string;
}

export interface ProjectionOutcome {
  /** False when the event referenced state we never saw (e.g. a proposal before the history window). */
  applied: boolean;
  warning?: string;
}

type Tx = Transaction<Database>;

/**
 * Applies one decoded contract event to the read model. Must run inside the same transaction
 * that records the raw event, so the projection, activity feed and notification outbox commit
 * atomically. Every write is idempotent with respect to replaying the same event.
 */
export async function projectEvent(
  tx: Tx,
  ctx: EventContext,
  event: DecodedBody,
  opts: { notify?: boolean } = {},
): Promise<ProjectionOutcome> {
  const outcome = await applyState(tx, ctx, event);
  const type = DOMAIN_EVENT_TYPES[event.name];
  const proposalId = 'id' in event.data ? event.data.id : null;
  const data = { ...event.data, ...(outcome.applied ? {} : { projectionWarning: outcome.warning }) };

  await tx
    .insertInto('activity')
    .values({
      contract_id: ctx.contractId,
      source: 'chain',
      type,
      actor: actorOf(event),
      proposal_id: proposalId,
      event_id: ctx.eventId,
      ledger: ctx.ledger,
      tx_hash: ctx.txHash,
      data: JSON.stringify(data),
      occurred_at: ctx.occurredAt,
    })
    .onConflict((oc) => oc.column('event_id').doNothing())
    .execute();

  if (opts.notify === false) return outcome;

  await tx
    .insertInto('notification_outbox')
    .values({
      contract_id: ctx.contractId,
      event_type: type,
      payload: JSON.stringify({
        type,
        treasuryId: ctx.contractId,
        eventId: ctx.eventId,
        ledger: ctx.ledger,
        txHash: ctx.txHash,
        occurredAt: ctx.occurredAt.toISOString(),
        data: event.data,
      }),
    })
    .execute();

  return outcome;
}

function actorOf(event: DecodedBody): string | null {
  switch (event.name) {
    case 'proposed':
      return event.data.proposer;
    case 'approved':
    case 'revoked':
      return event.data.approver;
    case 'executed':
      return event.data.executor;
    case 'cancelled':
      return event.data.by;
    case 'init':
      return event.data.admin;
    default:
      return null;
  }
}

async function proposalExists(tx: Tx, contractId: string, id: string): Promise<boolean> {
  const row = await tx
    .selectFrom('proposals')
    .select('proposal_id')
    .where('contract_id', '=', contractId)
    .where('proposal_id', '=', id)
    .executeTakeFirst();
  return row !== undefined;
}

const missingProposal = (id: string): ProjectionOutcome => ({
  applied: false,
  warning: `proposal ${id} is not indexed (created before the indexed history window)`,
});

async function applyState(tx: Tx, ctx: EventContext, event: DecodedBody): Promise<ProjectionOutcome> {
  const { contractId: cid, ledger, occurredAt } = ctx;

  switch (event.name) {
    case 'init': {
      const { admin, members, policy } = event.data;
      await tx
        .updateTable('treasuries')
        .set({
          status: 'active',
          admin,
          policy: JSON.stringify(policy),
          policy_version: policy.version,
          threshold: policy.threshold,
          initialized_ledger: ledger,
          initialized_at: occurredAt,
          updated_at: new Date(),
        })
        .where('contract_id', '=', cid)
        .execute();
      for (const account of members) {
        await upsertMember(tx, ctx, account, account === admin ? 'admin' : 'member');
      }
      if (admin && !members.includes(admin) && admin.startsWith('G')) {
        await upsertMember(tx, ctx, admin, 'admin');
      }
      return { applied: true };
    }

    case 'mem_add':
      await upsertMember(tx, ctx, event.data.member, event.data.role ?? 'member');
      return { applied: true };

    case 'mem_rm':
      await tx
        .deleteFrom('treasury_members')
        .where('contract_id', '=', cid)
        .where('account', '=', event.data.member)
        .execute();
      return { applied: true };

    case 'policy': {
      const { policy } = event.data;
      // Policy versions are monotonic on-chain; never let a replayed older event win.
      await tx
        .updateTable('treasuries')
        .set({
          policy: JSON.stringify(policy),
          policy_version: policy.version,
          threshold: policy.threshold,
          updated_at: new Date(),
        })
        .where('contract_id', '=', cid)
        .where((eb) => eb.or([eb('policy_version', 'is', null), eb('policy_version', '<', policy.version)]))
        .execute();
      return { applied: true };
    }

    case 'allow_add':
      await tx
        .insertInto('treasury_recipients')
        .values({
          contract_id: cid,
          address: event.data.recipient,
          label: event.data.label,
          added_ledger: ledger,
          added_at: occurredAt,
        })
        .onConflict((oc) =>
          oc
            .columns(['contract_id', 'address'])
            .doUpdateSet({ label: event.data.label, added_ledger: ledger }),
        )
        .execute();
      return { applied: true };

    case 'allow_rm':
      await tx
        .deleteFrom('treasury_recipients')
        .where('contract_id', '=', cid)
        .where('address', '=', event.data.recipient)
        .execute();
      return { applied: true };

    case 'proposed': {
      const d = event.data;
      await tx
        .insertInto('proposals')
        .values({
          contract_id: cid,
          proposal_id: d.id,
          proposer: d.proposer,
          recipient: d.recipient,
          token: d.token,
          amount: d.amount,
          department: d.department,
          metadata_hash: d.metadata_hash,
          policy_version: d.policy_version,
          required_approvals: d.required_approvals,
          status: 'pending',
          expires_at: new Date(Number(d.expires_at) * 1000),
          created_ledger: ledger,
          created_at: occurredAt,
          created_tx: ctx.txHash,
          updated_ledger: ledger,
        })
        .onConflict((oc) => oc.columns(['contract_id', 'proposal_id']).doNothing())
        .execute();
      return { applied: true };
    }

    case 'approved': {
      const d = event.data;
      if (!(await proposalExists(tx, cid, d.id))) return missingProposal(d.id);
      await tx
        .insertInto('proposal_approvals')
        .values({
          contract_id: cid,
          proposal_id: d.id,
          approver: d.approver,
          ledger,
          tx_hash: ctx.txHash,
          approved_at: occurredAt,
        })
        .onConflict((oc) => oc.columns(['contract_id', 'proposal_id', 'approver']).doNothing())
        .execute();
      await setApprovals(tx, cid, d.id, d.approvals, ledger);
      return { applied: true };
    }

    case 'revoked': {
      const d = event.data;
      if (!(await proposalExists(tx, cid, d.id))) return missingProposal(d.id);
      await tx
        .deleteFrom('proposal_approvals')
        .where('contract_id', '=', cid)
        .where('proposal_id', '=', d.id)
        .where('approver', '=', d.approver)
        .execute();
      await setApprovals(tx, cid, d.id, d.approvals, ledger);
      return { applied: true };
    }

    case 'executed': {
      const d = event.data;
      if (!(await proposalExists(tx, cid, d.id))) return missingProposal(d.id);
      await tx
        .updateTable('proposals')
        .set({
          status: 'executed',
          executed_by: d.executor,
          executed_at: occurredAt,
          executed_tx: ctx.txHash,
          updated_ledger: ledger,
        })
        .where('contract_id', '=', cid)
        .where('proposal_id', '=', d.id)
        .execute();
      return { applied: true };
    }

    case 'cancelled': {
      const d = event.data;
      if (!(await proposalExists(tx, cid, d.id))) return missingProposal(d.id);
      await tx
        .updateTable('proposals')
        .set({
          status: 'cancelled',
          cancelled_by: d.by,
          cancelled_at: occurredAt,
          cancelled_tx: ctx.txHash,
          updated_ledger: ledger,
        })
        .where('contract_id', '=', cid)
        .where('proposal_id', '=', d.id)
        .execute();
      return { applied: true };
    }
  }
}

async function upsertMember(tx: Tx, ctx: EventContext, account: string, role: string): Promise<void> {
  await tx
    .insertInto('treasury_members')
    .values({
      contract_id: ctx.contractId,
      account,
      role,
      added_ledger: ctx.ledger,
      added_at: ctx.occurredAt,
    })
    .onConflict((oc) => oc.columns(['contract_id', 'account']).doUpdateSet({ role }))
    .execute();
}

async function setApprovals(tx: Tx, cid: string, id: string, count: number, ledger: number): Promise<void> {
  await tx
    .updateTable('proposals')
    .set({ approvals_count: count, updated_ledger: ledger })
    .where('contract_id', '=', cid)
    .where('proposal_id', '=', id)
    .execute();
}
