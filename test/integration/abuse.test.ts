import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, login, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { randomContractId } from '../helpers/events.js';

/** Abuse scenarios from the security review (docs/THREAT_MODEL.md T8, T16-T19). */
let tdb: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  tdb = await createTestDatabase();
  t = await createTestApp(tdb.db, tdb.url, { SMTP_URL: 'smtp://mail.invalid:2525' });
});
afterAll(async () => {
  await t.app.close();
  await tdb.destroy();
});

describe('abuse resistance', () => {
  it('caps confirmation emails per address across many throwaway accounts (email bombing)', async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const sybil = await login(t.app);
      const res = await t.app.inject({
        method: 'POST',
        url: '/notifications/preferences',
        headers: sybil.headers,
        payload: { channel: 'email', email: 'Victim@Example.com' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([201, 201, 201, 429, 429]);
    // The rejected sign-ups left nothing behind.
    const subs = await tdb.db.selectFrom('notification_subscriptions').select('id').execute();
    expect(subs).toHaveLength(3);
  });

  it('caps confirmation resends for one subscription too', async () => {
    const s = await login(t.app);
    const sub = (
      await t.app.inject({
        method: 'POST',
        url: '/notifications/preferences',
        headers: s.headers,
        payload: { channel: 'email', email: 'other@example.com' },
      })
    ).json();
    const resend = (ip: string) =>
      t.app.inject({
        method: 'POST',
        url: `/notifications/preferences/${sub.id}/resend-verification`,
        headers: s.headers,
        remoteAddress: ip,
      });
    expect((await resend('198.51.100.1')).statusCode).toBe(202);
    expect((await resend('198.51.100.2')).statusCode).toBe(202);
    expect((await resend('198.51.100.3')).statusCode).toBe(429);
  });

  it('caps treasury registrations per account per day (indexer flooding)', async () => {
    const s = await login(t.app);
    await tdb.db
      .insertInto('treasuries')
      .values(
        Array.from({ length: 20 }, () => ({
          contract_id: randomContractId(),
          network: 'testnet',
          status: 'pending' as const,
          registered_by: s.account,
          start_ledger: 1,
          last_indexed_ledger: 1_000,
          created_at: new Date(),
        })),
      )
      .execute();
    const id = randomContractId();
    t.chain.wasmHashes.set(id, 'aa'.repeat(32));
    const res = await t.app.inject({
      method: 'POST',
      url: '/treasuries',
      headers: s.headers,
      payload: { contractId: id },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  it('rate limits registrations per IP with the default write limit', async () => {
    const strict = await createTestApp(tdb.db, tdb.url, { RATE_LIMIT_WRITE_MAX: '2' });
    const s = await login(strict.app);
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = await strict.app.inject({
        method: 'POST',
        url: '/treasuries',
        headers: s.headers,
        payload: { contractId: randomContractId() },
      });
      codes.push(res.statusCode);
    }
    await strict.app.close();
    expect(codes).toEqual([422, 422, 429]);
  });

  it('caches live balance reads so they cannot drain the RPC quota', async () => {
    const id = randomContractId();
    const token = randomContractId();
    const fresh = await createTestApp(tdb.db, tdb.url);
    fresh.chain.wasmHashes.set(id, 'aa'.repeat(32));
    fresh.chain.balances.set(`${token}:${id}`, '42');
    const s = await login(fresh.app);
    await fresh.app.inject({
      method: 'POST',
      url: '/treasuries',
      headers: s.headers,
      payload: { contractId: id },
    });
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        fresh.app.inject({ method: 'GET', url: `/treasuries/${id}/balances?tokens=${token}` }),
      ),
    );
    await fresh.app.close();
    expect(results.every((r) => r.json().balances[0].balance === '42')).toBe(true);
    expect(fresh.chain.balanceCalls).toBe(1);
  });
});
