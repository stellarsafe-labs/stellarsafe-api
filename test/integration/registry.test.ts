import { Keypair } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { createLogger } from '../../src/lib/logger.js';
import { metadataHash } from '../../src/modules/proposals/service.js';
import { createTestApp, login, type TestApp } from '../helpers/app.js';
import { createTestDatabase, truncateAll, type TestDatabase } from '../helpers/db.js';
import { EventFactory, randomAccount, randomContractId } from '../helpers/events.js';

let tdb: TestDatabase;
let t: TestApp;
const WASM = 'bb'.repeat(32);

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
});

/** Moves the chain tip forward so events created next land in ledgers the indexer has not scanned yet. */
const advance = (f: EventFactory) => {
  t.chain.latestLedger += 10;
  f.ledger = t.chain.latestLedger;
};

const indexAll = async () => {
  const ix = new Indexer(tdb.db, t.chain, createLogger('silent', false), {
    windowLedgers: 10_000,
    pollIntervalMs: 1,
  });
  while ((await ix.tick()).behind);
};

/** Registers and indexes a treasury whose members include the returned signed-in session. */
async function treasuryWithMember() {
  const session = await login(t.app);
  const id = randomContractId();
  t.chain.wasmHashes.set(id, WASM);
  const f = new EventFactory(id, 200);
  await t.app.inject({
    method: 'POST',
    url: '/treasuries',
    headers: session.headers,
    payload: { contractId: id, startLedger: 100 },
  });
  t.chain.events.push(f.init([session.account, randomAccount()], 2));
  await indexAll();
  return { id, f, session };
}

describe('treasury registration', () => {
  it('requires authentication', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/treasuries',
      payload: { contractId: randomContractId() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('defaults startLedger to the oldest retained ledger', async () => {
    const s = await login(t.app);
    const id = randomContractId();
    t.chain.wasmHashes.set(id, WASM);
    t.chain.oldestLedger = 321;
    const res = await t.app.inject({
      method: 'POST',
      url: '/treasuries',
      headers: s.headers,
      payload: { contractId: id },
    });
    t.chain.oldestLedger = 1;
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'pending',
      registeredBy: s.account,
      wasmHash: WASM,
      indexing: { startLedger: 321 },
    });
  });

  it.each([
    ['missing contract', null, 422],
    ['stellar asset contract', 'stellar_asset', 422],
  ])('rejects a %s', async (_name, hash, status) => {
    const s = await login(t.app);
    const id = randomContractId();
    if (hash) t.chain.wasmHashes.set(id, hash);
    const res = await t.app.inject({
      method: 'POST',
      url: '/treasuries',
      headers: s.headers,
      payload: { contractId: id },
    });
    expect(res.statusCode).toBe(status);
  });

  it('rejects duplicates and future start ledgers', async () => {
    const s = await login(t.app);
    const id = randomContractId();
    t.chain.wasmHashes.set(id, WASM);
    const post = (payload: object) =>
      t.app.inject({ method: 'POST', url: '/treasuries', headers: s.headers, payload });
    expect((await post({ contractId: id, startLedger: 5_000 })).statusCode).toBe(400);
    expect((await post({ contractId: id })).statusCode).toBe(201);
    expect((await post({ contractId: id })).statusCode).toBe(409);
  });

  it('enforces the trusted WASM allowlist when configured', async () => {
    const strict = await createTestApp(tdb.db, tdb.url, { TRUSTED_WASM_HASHES: 'cc'.repeat(32) });
    const s = await login(strict.app);
    const bad = randomContractId();
    const good = randomContractId();
    strict.chain.wasmHashes.set(bad, WASM);
    strict.chain.wasmHashes.set(good, 'cc'.repeat(32));
    const post = (contractId: string) =>
      strict.app.inject({ method: 'POST', url: '/treasuries', headers: s.headers, payload: { contractId } });
    const rejected = await post(bad);
    const accepted = await post(good);
    await strict.app.close();
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.details).toEqual({ wasmHash: WASM });
    expect(accepted.statusCode).toBe(201);
  });
});

describe('treasury queries', () => {
  it('lists with cursor pagination and member filter', async () => {
    const { session } = await treasuryWithMember();
    await treasuryWithMember();
    await treasuryWithMember();

    const p1 = (await t.app.inject({ method: 'GET', url: '/treasuries?limit=2' })).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await t.app.inject({ method: 'GET', url: `/treasuries?limit=2&cursor=${p1.nextCursor}` })
    ).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(3);

    const mine = (await t.app.inject({ method: 'GET', url: `/treasuries?member=${session.account}` })).json();
    expect(mine.items).toHaveLength(1);
    const active = (await t.app.inject({ method: 'GET', url: '/treasuries?status=pending' })).json();
    expect(active.items).toHaveLength(0);
  });

  it('rejects bad ids, bad cursors and unknown treasuries', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/treasuries/nope' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/treasuries?cursor=xyz' })).statusCode).toBe(400);
    const missing = await t.app.inject({ method: 'GET', url: `/treasuries/${randomContractId()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    for (const sub of ['members', 'recipients', 'proposals', 'activity', 'balances']) {
      expect(
        (await t.app.inject({ method: 'GET', url: `/treasuries/${randomContractId()}/${sub}` })).statusCode,
      ).toBe(404);
    }
  });

  it('only members can edit display metadata, and edits are audited', async () => {
    const { id, session } = await treasuryWithMember();
    const outsider = await login(t.app);
    const patch = (headers: Record<string, string>, payload: object) =>
      t.app.inject({ method: 'PATCH', url: `/treasuries/${id}`, headers, payload });

    expect((await patch(outsider.headers, { name: 'Hijacked' })).statusCode).toBe(403);
    expect((await patch(session.headers, {})).statusCode).toBe(400);
    const ok = await patch(session.headers, { name: 'Payroll', description: 'Monthly salaries' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'Payroll', description: 'Monthly salaries' });

    const audit = (
      await t.app.inject({ method: 'GET', url: `/treasuries/${id}/activity?source=api` })
    ).json();
    expect(audit.items.map((a: { type: string }) => a.type)).toEqual([
      'treasury.metadata_updated',
      'treasury.registered',
    ]);
    expect(audit.items[0].actor).toBe(session.account);
  });

  it('reads live balances from chain', async () => {
    const { id, f, session } = await treasuryWithMember();
    const usdc = randomContractId();
    const xlm = randomContractId();
    t.chain.balances.set(`${usdc}:${id}`, '200000000000');
    advance(f);
    t.chain.events.push(
      f.proposed({ id: 1, proposer: session.account, recipient: session.account, token: usdc, amount: 1 }),
    );
    await indexAll();
    const res = await t.app.inject({ method: 'GET', url: `/treasuries/${id}/balances?tokens=${xlm}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().balances).toEqual(
      expect.arrayContaining([
        { token: usdc, balance: '200000000000' },
        { token: xlm, balance: null },
      ]),
    );
  });
});

describe('proposals and metadata', () => {
  it('links content-addressed metadata to the proposal that commits to its hash', async () => {
    const { id, f, session } = await treasuryWithMember();
    const body = { title: 'March payroll', description: 'Salaries for 4 contributors', category: 'payroll' };
    const created = await t.app.inject({
      method: 'POST',
      url: `/treasuries/${id}/proposal-metadata`,
      headers: session.headers,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const hash = created.json().metadataHash;
    expect(hash).toBe(metadataHash(body));

    // Idempotent: same content, same hash.
    const again = await t.app.inject({
      method: 'POST',
      url: `/treasuries/${id}/proposal-metadata`,
      headers: session.headers,
      payload: body,
    });
    expect(again.json().metadataHash).toBe(hash);

    advance(f);
    t.chain.events.push(
      f.proposed({
        id: 7,
        proposer: session.account,
        recipient: randomAccount(),
        token: id,
        amount: 100,
        metadataHash: hash,
      }),
      f.proposed({
        id: 8,
        proposer: session.account,
        recipient: randomAccount(),
        token: id,
        amount: 100,
        metadataHash: 'ff'.repeat(32),
      }),
    );
    await indexAll();

    const p7 = (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/proposals/7` })).json();
    expect(p7.metadata).toMatchObject({
      title: 'March payroll',
      category: 'payroll',
      verified: true,
      createdBy: session.account,
    });
    const p8 = (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/proposals/8` })).json();
    expect(p8.metadata).toBeNull();

    const fetched = await t.app.inject({ method: 'GET', url: `/treasuries/${id}/proposal-metadata/${hash}` });
    expect(fetched.json().title).toBe('March payroll');
  });

  it('only members can store metadata', async () => {
    const { id } = await treasuryWithMember();
    const outsider = await login(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: `/treasuries/${id}/proposal-metadata`,
      headers: outsider.headers,
      payload: { title: 'x', description: 'y' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('filters by computed status and paginates by proposal id', async () => {
    const { id, f, session } = await treasuryWithMember();
    const base = { proposer: session.account, recipient: randomAccount(), token: id, amount: 1 };
    const past = Math.floor(Date.now() / 1000) - 60;
    advance(f);
    t.chain.events.push(
      f.proposed({ ...base, id: 1 }),
      f.proposed({ ...base, id: 2, expiresAt: past }),
      f.proposed({ ...base, id: 3 }),
      f.cancelled(3, session.account),
      f.proposed({ ...base, id: 10 }),
    );
    await indexAll();
    const list = async (q: string) =>
      (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/proposals?${q}` })).json();

    expect((await list('status=pending')).items.map((p: { id: string }) => p.id)).toEqual(['10', '1']);
    expect((await list('status=expired')).items.map((p: { id: string }) => p.id)).toEqual(['2']);
    expect((await list('status=cancelled')).items[0].cancelled.by).toBe(session.account);
    expect((await list(`proposer=${randomAccount()}`)).items).toEqual([]);

    const page1 = await list('limit=2');
    expect(page1.items.map((p: { id: string }) => p.id)).toEqual(['10', '3']);
    const page2 = await list(`limit=2&cursor=${page1.nextCursor}`);
    expect(page2.items.map((p: { id: string }) => p.id)).toEqual(['2', '1']);
    expect(page2.nextCursor).toBeNull();

    expect((await t.app.inject({ method: 'GET', url: `/treasuries/${id}/proposals/999` })).statusCode).toBe(
      404,
    );
    expect((await t.app.inject({ method: 'GET', url: `/treasuries/${id}/proposals/-1` })).statusCode).toBe(
      400,
    );
    expect(
      (await t.app.inject({ method: 'GET', url: '/treasuries/' + id + '/proposals/99999999999999999999' }))
        .statusCode,
    ).toBe(400);

    const treasury = (await t.app.inject({ method: 'GET', url: `/treasuries/${id}` })).json();
    expect(treasury.pendingProposalCount).toBe(2);
  });
});

describe('activity', () => {
  it('filters, paginates and exports CSV', async () => {
    const { id, f, session } = await treasuryWithMember();
    const bob = Keypair.random().publicKey();
    advance(f);
    t.chain.events.push(
      f.proposed({ id: 1, proposer: session.account, recipient: bob, token: id, amount: 5 }),
      f.approved(1, bob, 1),
      f.executed(1, bob),
    );
    await indexAll();
    const q = async (params: string) =>
      (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/activity?${params}` })).json();

    expect((await q('type=proposal.*')).items).toHaveLength(3);
    expect((await q(`actor=${bob}`)).items.map((a: { type: string }) => a.type)).toEqual([
      'proposal.executed',
      'proposal.approved',
    ]);
    expect((await q('proposalId=1')).items).toHaveLength(3);
    expect((await q('since=2999-01-01T00:00:00Z')).items).toHaveLength(0);

    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await q(`limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      all.push(...page.items.map((a: { id: string }) => a.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(5); // registered + init + 3 proposal events
    expect(new Set(all).size).toBe(5);

    const csv = await t.app.inject({ method: 'GET', url: `/treasuries/${id}/activity/export?source=chain` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(`${id}-activity.csv`);
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe('occurred_at,source,type,actor,proposal_id,ledger,tx_hash,event_id,data');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('treasury.initialized');
  });

  it('rejects invalid filters', async () => {
    const { id } = await treasuryWithMember();
    expect(
      (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/activity?type=DROP TABLE` })).statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/activity?limit=1000` })).statusCode,
    ).toBe(400);
  });
});
