import { Keypair } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { createLogger } from '../../src/lib/logger.js';
import { createTestApp, login, type TestApp } from '../helpers/app.js';
import { createTestDatabase, truncateAll, type TestDatabase } from '../helpers/db.js';
import { EventFactory, randomAccount, randomContractId, sv } from '../helpers/events.js';

let tdb: TestDatabase;
let t: TestApp;
let indexer: Indexer;
const log = createLogger('silent', false);
const WASM = 'aa'.repeat(32);

beforeAll(async () => {
  tdb = await createTestDatabase();
  t = await createTestApp(tdb.db, tdb.url);
});
afterAll(async () => {
  await t.app.close();
  await tdb.destroy();
});
beforeEach(async () => {
  await truncateAll(tdb.db);
  t.chain.events = [];
  t.chain.calls = [];
  t.chain.latestLedger = 1_000;
  t.chain.oldestLedger = 1;
  indexer = new Indexer(tdb.db, t.chain, log, { windowLedgers: 100, pollIntervalMs: 10 });
});

async function register(contractId: string, startLedger = 100) {
  t.chain.wasmHashes.set(contractId, WASM);
  const s = await login(t.app);
  const res = await t.app.inject({
    method: 'POST',
    url: '/treasuries',
    headers: s.headers,
    payload: { contractId, startLedger, name: 'Ops treasury' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function drain() {
  for (let i = 0; i < 100; i++) {
    const r = await indexer.tick();
    if (!r.behind) return;
  }
  throw new Error('indexer did not catch up');
}

const get = async (url: string) => {
  const res = await t.app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json();
};

describe('indexer', () => {
  it('projects a full proposal lifecycle', async () => {
    const id = randomContractId();
    const f = new EventFactory(id, 150);
    const [alice, bob, carol] = [randomAccount(), randomAccount(), randomAccount()];
    const token = randomContractId();
    const recipient = randomAccount();
    await register(id);

    t.chain.events.push(
      f.init([alice, bob, carol], 2, alice),
      f.allowAdded(recipient, 'Vendor'),
      f.proposed({ id: 1, proposer: alice, recipient, token, amount: 750_0000000n, department: 'eng' }),
      f.approved(1, alice, 1),
      f.approved(1, bob, 2),
      f.revoked(1, bob, 1),
      f.approved(1, carol, 2),
      f.executed(1, carol),
    );
    await drain();

    const treasury = await get(`/treasuries/${id}`);
    expect(treasury).toMatchObject({
      status: 'active',
      admin: alice,
      policyVersion: 1,
      threshold: 2,
      memberCount: 3,
      indexing: { lastIndexedLedger: 1_000, historyComplete: true },
    });

    const members = await get(`/treasuries/${id}/members`);
    expect(members.items.map((m: { account: string }) => m.account).sort()).toEqual(
      [alice, bob, carol].sort(),
    );
    expect(members.items.find((m: { account: string }) => m.account === alice).role).toBe('admin');

    const proposal = await get(`/treasuries/${id}/proposals/1`);
    expect(proposal).toMatchObject({
      status: 'executed',
      amount: '7500000000',
      department: 'eng',
      recipientAllowlisted: true,
      approvalsCount: 2,
      executed: { by: carol },
      policyOutdated: false,
    });
    expect(proposal.approvals.map((a: { approver: string }) => a.approver).sort()).toEqual(
      [alice, carol].sort(),
    );

    const activity = await get(`/treasuries/${id}/activity?source=chain&limit=100`);
    expect(activity.items.map((a: { type: string }) => a.type).reverse()).toEqual([
      'treasury.initialized',
      'recipient.added',
      'proposal.created',
      'proposal.approved',
      'proposal.approved',
      'proposal.approval_revoked',
      'proposal.approved',
      'proposal.executed',
    ]);

    const outbox = await tdb.db.selectFrom('notification_outbox').select('event_type').execute();
    expect(outbox).toHaveLength(8);
  });

  it('is idempotent: re-ingesting the same window changes nothing', async () => {
    const id = randomContractId();
    const f = new EventFactory(id, 150);
    const alice = randomAccount();
    await register(id);
    t.chain.events.push(
      f.init([alice], 1),
      f.proposed({ id: 1, proposer: alice, recipient: alice, token: id, amount: 5 }),
    );
    await drain();

    // Rewind the checkpoint as if the process crashed before the commit was observed.
    await tdb.db.updateTable('treasuries').set({ last_indexed_ledger: 99 }).execute();
    await drain();

    const counts = await Promise.all(
      ['chain_events', 'activity', 'notification_outbox', 'proposals'].map(async (table) =>
        Number(
          (
            await tdb.db
              .selectFrom(table as 'chain_events')
              .select((eb) => eb.fn.countAll<string>().as('c'))
              .where('contract_id', '=', id)
              .executeTakeFirstOrThrow()
          ).c,
        ),
      ),
    );
    // activity also contains the api-side "treasury.registered" entry
    expect(counts).toEqual([2, 3, 2, 1]);
  });

  it('scans in bounded windows and checkpoints each one', async () => {
    const id = randomContractId();
    await register(id, 100);
    t.chain.latestLedger = 450;
    await drain();
    expect(t.chain.calls.map((c) => [c.start, c.end])).toEqual([
      [100, 199],
      [200, 299],
      [300, 399],
      [400, 450],
    ]);
    // Caught up: next tick fetches nothing.
    t.chain.calls = [];
    expect((await indexer.tick()).behind).toBe(false);
    expect(t.chain.calls).toHaveLength(0);
  });

  it('backfills a newly registered treasury without stalling caught-up ones', async () => {
    const old = randomContractId();
    await register(old, 900);
    await drain();
    const fresh = randomContractId();
    await register(fresh, 500);
    t.chain.latestLedger = 1_010;
    t.chain.calls = [];

    await indexer.tick();
    // Both groups progress in the same tick.
    expect(t.chain.calls).toEqual(
      expect.arrayContaining([
        { start: 1_001, end: 1_010, ids: [old] },
        { start: 500, end: 599, ids: [fresh] },
      ]),
    );
    await drain();
    const rows = await tdb.db.selectFrom('treasuries').select('last_indexed_ledger').execute();
    expect(rows.every((r) => r.last_indexed_ledger === 1_010)).toBe(true);
  });

  it('flags treasuries whose history fell out of RPC retention', async () => {
    const id = randomContractId();
    await register(id, 10);
    t.chain.oldestLedger = 600;
    await drain();
    const treasury = await get(`/treasuries/${id}`);
    expect(treasury.indexing).toMatchObject({ historyComplete: false, lastIndexedLedger: 1_000 });
    expect(t.chain.calls[0]!.start).toBe(600);
  });

  it('stores invalid events with the decode error and keeps going', async () => {
    const id = randomContractId();
    const f = new EventFactory(id, 150);
    const alice = randomAccount();
    await register(id);
    t.chain.events.push(
      f.event('approved', { id: sv.u64(1), approver: sv.u32(7), approvals: sv.u32(1) }),
      f.event('some_other_event', { x: sv.u32(1) }),
      f.init([alice], 1),
    );
    await drain();
    const events = await tdb.db
      .selectFrom('chain_events')
      .select(['event_type', 'decode_error'])
      .orderBy('id')
      .execute();
    expect(events[0]!.decode_error).toContain('invalid "approved" body');
    expect(events[1]!.decode_error).toContain('unknown event');
    expect(events[2]!.decode_error).toBeNull();
    expect((await get(`/treasuries/${id}`)).status).toBe('active');
  });

  it('records events for proposals created before the indexed window as partial', async () => {
    const id = randomContractId();
    const f = new EventFactory(id, 150);
    const alice = randomAccount();
    await register(id);
    t.chain.events.push(f.approved(99, alice, 1));
    await drain();
    const activity = await get(`/treasuries/${id}/activity?type=proposal.approved`);
    expect(activity.items[0].data.projectionWarning).toContain('not indexed');
  });

  it('applies membership, allowlist and policy changes; flags outdated proposals', async () => {
    const id = randomContractId();
    const f = new EventFactory(id, 150);
    const [alice, bob, dave] = [randomAccount(), randomAccount(), randomAccount()];
    const vendor = randomContractId();
    await register(id);
    t.chain.events.push(
      f.init([alice, bob], 2),
      f.proposed({ id: 1, proposer: alice, recipient: vendor, token: id, amount: 10 }),
      f.approved(1, bob, 1),
      f.memberAdded(dave, 'finance'),
      f.memberRemoved(bob),
      f.allowAdded(vendor),
      f.allowRemoved(vendor),
      f.policyUpdated(3, 1),
      f.policyUpdated(2, 5), // stale replay: must not win
    );
    await drain();

    const treasury = await get(`/treasuries/${id}`);
    expect(treasury).toMatchObject({ policyVersion: 3, threshold: 1, memberCount: 2 });
    const members = (await get(`/treasuries/${id}/members`)).items;
    expect(members.find((m: { account: string }) => m.account === dave).role).toBe('finance');
    expect((await get(`/treasuries/${id}/recipients`)).items).toEqual([]);

    const proposal = await get(`/treasuries/${id}/proposals/1`);
    expect(proposal.policyOutdated).toBe(true);
    expect(proposal.recipientAllowlisted).toBe(false);
    expect(proposal.approvals[0]).toMatchObject({ approver: bob, approverIsMember: false });
  });

  it('never double-applies when two indexers race', async () => {
    const id = randomContractId();
    const f = new EventFactory(id, 150);
    const alice = randomAccount();
    await register(id);
    t.chain.events.push(
      f.init([alice], 1),
      f.proposed({ id: 1, proposer: alice, recipient: alice, token: id, amount: 1 }),
    );
    const other = new Indexer(tdb.db, t.chain, log, { windowLedgers: 100, pollIntervalMs: 10 });
    for (let i = 0; i < 12; i++) await Promise.all([indexer.tick(), other.tick()]);
    const outbox = await tdb.db.selectFrom('notification_outbox').selectAll().execute();
    expect(outbox).toHaveLength(2);
    expect((await get(`/treasuries/${id}`)).indexing.lastIndexedLedger).toBe(1_000);
  });

  it('runs as a background loop and backs off on RPC errors', async () => {
    const id = randomContractId();
    const f = new EventFactory(id, 150);
    await register(id);
    t.chain.events.push(f.init([Keypair.random().publicKey()], 1));
    t.chain.failNext = 1;
    indexer.start();
    for (let i = 0; i < 100; i++) {
      const row = await tdb.db.selectFrom('treasuries').select('status').executeTakeFirstOrThrow();
      if (row.status === 'active') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await indexer.stop();
    expect((await get(`/treasuries/${id}`)).status).toBe('active');
  });
});
