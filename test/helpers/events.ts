import { randomBytes } from 'node:crypto';
import { Address, Keypair, nativeToScVal, StrKey, xdr } from '@stellar/stellar-sdk';
import type { RawContractEvent } from '../../src/indexer/decoder.js';

export const randomContractId = () => StrKey.encodeContract(randomBytes(32));
export const randomAccount = () => Keypair.random().publicKey();

/** ScVal builders mirroring Soroban contract types. */
export const sv = {
  u32: (n: number) => xdr.ScVal.scvU32(n),
  u64: (n: number | bigint) => nativeToScVal(BigInt(n), { type: 'u64' }),
  i128: (n: number | bigint) => nativeToScVal(BigInt(n), { type: 'i128' }),
  bool: (b: boolean) => xdr.ScVal.scvBool(b),
  sym: (s: string) => xdr.ScVal.scvSymbol(s),
  str: (s: string) => xdr.ScVal.scvString(s),
  addr: (a: string) => new Address(a).toScVal(),
  bytes: (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, 'hex')),
  none: () => xdr.ScVal.scvVoid(),
  vec: (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items),
  map: (fields: Record<string, xdr.ScVal>) =>
    xdr.ScVal.scvMap(
      Object.keys(fields)
        .sort()
        .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! })),
    ),
};

export const policy = (version: number, threshold: number, extra: Record<string, xdr.ScVal> = {}) =>
  sv.map({ version: sv.u32(version), threshold: sv.u32(threshold), ...extra });

/** Event ids are globally unique on Stellar (TOID-based), so the counter is shared by all factories. */
let globalSeq = 0;

/** Builds events for one contract with increasing, RPC-style ids. */
export class EventFactory {
  constructor(
    readonly contractId: string,
    public ledger = 100,
  ) {}

  event(
    name: string,
    body: Record<string, xdr.ScVal>,
    opts: { ledger?: number; extraTopics?: xdr.ScVal[] } = {},
  ) {
    const ledger = opts.ledger ?? this.ledger;
    globalSeq++;
    const e: RawContractEvent = {
      id: `${String(ledger).padStart(19, '0')}-${String(globalSeq).padStart(10, '0')}`,
      contractId: this.contractId,
      ledger,
      ledgerClosedAt: new Date(Date.UTC(2026, 0, 1) + ledger * 5000).toISOString(),
      txHash: randomBytes(32).toString('hex'),
      topic: [sv.sym(name), ...(opts.extraTopics ?? [])],
      value: sv.map(body),
    };
    return e;
  }

  init(members: string[], threshold = 2, admin?: string) {
    return this.event('init', {
      admin: admin ? sv.addr(admin) : sv.none(),
      members: sv.vec(members.map(sv.addr)),
      policy: policy(1, threshold, { high_value_amount: sv.i128(500_0000000) }),
    });
  }

  proposed(p: {
    id: number;
    proposer: string;
    recipient: string;
    token: string;
    amount: bigint | number;
    expiresAt?: number;
    policyVersion?: number;
    required?: number;
    metadataHash?: string;
    department?: string;
  }) {
    return this.event('proposed', {
      id: sv.u64(p.id),
      proposer: sv.addr(p.proposer),
      recipient: sv.addr(p.recipient),
      token: sv.addr(p.token),
      amount: sv.i128(p.amount),
      expires_at: sv.u64(p.expiresAt ?? Math.floor(Date.now() / 1000) + 86_400),
      policy_version: sv.u32(p.policyVersion ?? 1),
      required_approvals: sv.u32(p.required ?? 2),
      department: p.department ? sv.sym(p.department) : sv.none(),
      metadata_hash: p.metadataHash ? sv.bytes(p.metadataHash) : sv.none(),
    });
  }

  approved(id: number, approver: string, approvals: number) {
    return this.event('approved', {
      id: sv.u64(id),
      approver: sv.addr(approver),
      approvals: sv.u32(approvals),
    });
  }

  revoked(id: number, approver: string, approvals: number) {
    return this.event('revoked', {
      id: sv.u64(id),
      approver: sv.addr(approver),
      approvals: sv.u32(approvals),
    });
  }

  executed(id: number, executor: string) {
    return this.event('executed', {
      id: sv.u64(id),
      executor: sv.addr(executor),
      period_spent: sv.i128(100),
    });
  }

  cancelled(id: number, by: string) {
    return this.event('cancelled', { id: sv.u64(id), by: sv.addr(by) });
  }

  memberAdded(member: string, role?: string) {
    return this.event('mem_add', { member: sv.addr(member), role: role ? sv.sym(role) : sv.none() });
  }

  memberRemoved(member: string) {
    return this.event('mem_rm', { member: sv.addr(member) });
  }

  policyUpdated(version: number, threshold: number) {
    return this.event('policy', { policy: policy(version, threshold) });
  }

  allowAdded(recipient: string, label?: string) {
    return this.event('allow_add', {
      recipient: sv.addr(recipient),
      label: label ? sv.str(label) : sv.none(),
    });
  }

  allowRemoved(recipient: string) {
    return this.event('allow_rm', { recipient: sv.addr(recipient) });
  }
}
