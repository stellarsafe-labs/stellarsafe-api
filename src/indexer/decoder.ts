import { scValToNative, type xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { accountIdSchema, addressSchema } from '../lib/stellar.js';

/**
 * Decodes StellarSafe contract events (schema v1, see docs/EVENTS.md).
 *
 * Every event is `topics[0] = Symbol(<name>)` with a `Map<Symbol, Val>` body. Extra topics and
 * extra body fields are ignored, so contracts can add indexed topics or fields without breaking
 * the indexer. Unknown event names are kept in the raw log but produce no projection.
 */

/** Convert scValToNative output into plain JSON (bigint -> decimal string, bytes -> hex). */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), toJsonSafe(v)]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

const u32 = z.number().int().min(0).max(0xffffffff);
const u64 = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,20}$/));
const positiveI128 = z
  .union([z.string(), z.number().int()])
  .transform(String)
  .pipe(z.string().regex(/^[1-9]\d{0,38}$/, 'amount must be a positive integer'));
const nonNegativeI128 = z
  .union([z.string(), z.number().int()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,39}$/));
const symbol = z.string().min(1).max(32);
const hash32 = z.string().regex(/^[0-9a-f]{64}$/);
const optional = <T extends z.ZodType>(s: T) => s.nullish().transform((v) => v ?? null);

export const policySchema = z.looseObject({
  version: u32,
  threshold: u32,
});
export type Policy = z.infer<typeof policySchema>;

const bodies = {
  init: z.object({
    admin: optional(addressSchema),
    members: z.array(accountIdSchema).max(100),
    policy: policySchema,
  }),
  mem_add: z.object({ member: accountIdSchema, role: optional(symbol) }),
  mem_rm: z.object({ member: accountIdSchema }),
  policy: z.object({ policy: policySchema }),
  allow_add: z.object({ recipient: addressSchema, label: optional(z.string().max(200)) }),
  allow_rm: z.object({ recipient: addressSchema }),
  proposed: z.object({
    id: u64,
    proposer: accountIdSchema,
    recipient: addressSchema,
    token: addressSchema,
    amount: positiveI128,
    expires_at: u64,
    policy_version: u32,
    required_approvals: u32,
    department: optional(symbol),
    metadata_hash: optional(hash32),
  }),
  approved: z.object({ id: u64, approver: accountIdSchema, approvals: u32 }),
  revoked: z.object({ id: u64, approver: accountIdSchema, approvals: u32 }),
  executed: z.object({ id: u64, executor: accountIdSchema, period_spent: optional(nonNegativeI128) }),
  cancelled: z.object({ id: u64, by: accountIdSchema }),
} as const;

export type ContractEventName = keyof typeof bodies;
export const CONTRACT_EVENT_NAMES = Object.keys(bodies) as ContractEventName[];

/** Public, stable names used in the activity feed, webhooks and the API. */
export const DOMAIN_EVENT_TYPES = {
  init: 'treasury.initialized',
  mem_add: 'member.added',
  mem_rm: 'member.removed',
  policy: 'policy.updated',
  allow_add: 'recipient.added',
  allow_rm: 'recipient.removed',
  proposed: 'proposal.created',
  approved: 'proposal.approved',
  revoked: 'proposal.approval_revoked',
  executed: 'proposal.executed',
  cancelled: 'proposal.cancelled',
} as const satisfies Record<ContractEventName, string>;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[ContractEventName];
export const DOMAIN_EVENT_TYPE_VALUES = Object.values(DOMAIN_EVENT_TYPES) as [
  DomainEventType,
  ...DomainEventType[],
];

export type DecodedBody = {
  [K in ContractEventName]: { name: K; data: z.infer<(typeof bodies)[K]> };
}[ContractEventName];

/** Minimal event shape, matching `rpc.Api.EventResponse` from the Stellar SDK. */
export interface RawContractEvent {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

export type DecodeResult =
  { ok: true; event: DecodedBody } | { ok: false; name: string | null; error: string; ignorable: boolean };

export function decodeEvent(raw: Pick<RawContractEvent, 'topic' | 'value'>): DecodeResult {
  const [first] = raw.topic;
  if (!first || first.type !== 'scvSymbol') {
    return { ok: false, name: null, error: 'topic[0] is not a Symbol', ignorable: true };
  }
  const name = first.value;
  if (!(name in bodies)) {
    return { ok: false, name, error: `unknown event "${name}"`, ignorable: true };
  }
  let native: unknown;
  try {
    native = toJsonSafe(scValToNative(raw.value));
  } catch (err) {
    return { ok: false, name, error: `cannot decode body: ${(err as Error).message}`, ignorable: false };
  }
  const parsed = bodies[name as ContractEventName].safeParse(native);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, name, error: `invalid "${name}" body: ${issues}`, ignorable: false };
  }
  return { ok: true, event: { name, data: parsed.data } as DecodedBody };
}
