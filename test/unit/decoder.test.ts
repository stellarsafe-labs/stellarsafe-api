import { describe, expect, it } from 'vitest';
import { decodeEvent, DOMAIN_EVENT_TYPES, toJsonSafe } from '../../src/indexer/decoder.js';
import { EventFactory, randomAccount, randomContractId, sv } from '../helpers/events.js';

const f = new EventFactory(randomContractId());
const [a, b] = [randomAccount(), randomAccount()];
const token = randomContractId();

describe('decodeEvent', () => {
  it('decodes init with policy and members', () => {
    const r = decodeEvent(f.init([a, b], 2, a));
    expect(r.ok).toBe(true);
    if (!r.ok || r.event.name !== 'init') throw new Error('unexpected');
    expect(r.event.data.members).toEqual([a, b]);
    expect(r.event.data.admin).toBe(a);
    expect(r.event.data.policy).toMatchObject({ version: 1, threshold: 2, high_value_amount: '5000000000' });
  });

  it('decodes a proposal with u64/i128 as decimal strings and bytes as hex', () => {
    const hash = 'ab'.repeat(32);
    const r = decodeEvent(
      f.proposed({
        id: 42,
        proposer: a,
        recipient: b,
        token,
        amount: 2n ** 100n,
        metadataHash: hash,
        department: 'ops',
      }),
    );
    if (!r.ok || r.event.name !== 'proposed') throw new Error(JSON.stringify(r));
    expect(r.event.data).toMatchObject({
      id: '42',
      amount: (2n ** 100n).toString(),
      metadata_hash: hash,
      department: 'ops',
      token,
    });
  });

  it('treats Option::None (void) as null', () => {
    const r = decodeEvent(f.proposed({ id: 1, proposer: a, recipient: b, token, amount: 1 }));
    if (!r.ok || r.event.name !== 'proposed') throw new Error('unexpected');
    expect(r.event.data.metadata_hash).toBeNull();
    expect(r.event.data.department).toBeNull();
  });

  it.each([
    ['approved', f.approved(1, a, 1)],
    ['revoked', f.revoked(1, a, 0)],
    ['executed', f.executed(1, a)],
    ['cancelled', f.cancelled(1, a)],
    ['mem_add', f.memberAdded(a, 'admin')],
    ['mem_rm', f.memberRemoved(a)],
    ['policy', f.policyUpdated(2, 3)],
    ['allow_add', f.allowAdded(b, 'Payroll')],
    ['allow_rm', f.allowRemoved(b)],
  ])('decodes %s', (name, event) => {
    const r = decodeEvent(event);
    expect(r).toMatchObject({ ok: true, event: { name } });
  });

  it('ignores extra topics and extra body fields', () => {
    const e = f.event(
      'approved',
      { id: sv.u64(1), approver: sv.addr(a), approvals: sv.u32(1), extra: sv.bool(true) },
      {
        extraTopics: [sv.u64(1)],
      },
    );
    expect(decodeEvent(e).ok).toBe(true);
  });

  it('marks unknown event names as ignorable', () => {
    expect(decodeEvent(f.event('transfer', {}))).toMatchObject({
      ok: false,
      name: 'transfer',
      ignorable: true,
    });
  });

  it('marks events without a symbol topic as ignorable', () => {
    const e = f.event('x', {});
    e.topic = [sv.u32(1)];
    expect(decodeEvent(e)).toMatchObject({ ok: false, name: null, ignorable: true });
  });

  it('rejects malformed bodies of known events', () => {
    const r = decodeEvent(
      f.event('approved', { id: sv.u64(1), approver: sv.addr(randomContractId()), approvals: sv.u32(1) }),
    );
    expect(r).toMatchObject({ ok: false, name: 'approved', ignorable: false });
    if (!r.ok) expect(r.error).toContain('approver');
  });

  it('rejects zero or negative amounts', () => {
    expect(decodeEvent(f.proposed({ id: 1, proposer: a, recipient: b, token, amount: 0 })).ok).toBe(false);
    expect(decodeEvent(f.proposed({ id: 1, proposer: a, recipient: b, token, amount: -5 })).ok).toBe(false);
  });

  it('has a public domain type for every contract event', () => {
    expect(Object.values(DOMAIN_EVENT_TYPES)).toContain('proposal.created');
    expect(new Set(Object.values(DOMAIN_EVENT_TYPES)).size).toBe(Object.keys(DOMAIN_EVENT_TYPES).length);
  });
});

describe('toJsonSafe', () => {
  it('converts nested bigints, bytes and maps', () => {
    expect(toJsonSafe({ a: [1n, new Uint8Array([1, 255])], m: new Map([['k', 2n]]) })).toEqual({
      a: ['1', '01ff'],
      m: { k: '2' },
    });
  });
});
