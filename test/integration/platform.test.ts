import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { reprojectTreasury } from '../../src/indexer/reproject.js';
import { createLogger } from '../../src/lib/logger.js';
import { createWorkers, runMaintenance } from '../../src/workers.js';
import { createTestApp, login, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { EventFactory, randomAccount, randomContractId } from '../helpers/events.js';

let tdb: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  tdb = await createTestDatabase();
  t = await createTestApp(tdb.db, tdb.url, {
    METRICS_TOKEN: 'metrics-token-1234567890',
    CORS_ORIGINS: 'https://app.stellarsafe.test',
  });
});
afterAll(async () => {
  await t.app.close();
  await tdb.destroy();
});

describe('health', () => {
  it('liveness', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: '0.1.0' });
  });

  it('readiness reports ok, then degraded when RPC fails or the indexer lags', async () => {
    const ok = await t.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ok.json()).toMatchObject({
      status: 'ok',
      checks: { database: { ok: true }, rpc: { ok: true, latestLedger: 1000 } },
    });

    // RPC results are cached for 5s, so hammering the public probe does not hammer RPC.
    const calls = t.chain.boundsCalls;
    await Promise.all(
      Array.from({ length: 20 }, () => t.app.inject({ method: 'GET', url: '/health/ready' })),
    );
    expect(t.chain.boundsCalls).toBe(calls);

    const fresh = await createTestApp(tdb.db, tdb.url);
    fresh.chain.failNext = 1;
    const degraded = await fresh.app.inject({ method: 'GET', url: '/health/ready' });
    await fresh.app.close();
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({ status: 'degraded', checks: { rpc: { ok: false } } });

    const id = randomContractId();
    t.chain.wasmHashes.set(id, 'aa'.repeat(32));
    const s = await login(t.app);
    await t.app.inject({
      method: 'POST',
      url: '/treasuries',
      headers: s.headers,
      payload: { contractId: id, startLedger: 10 },
    });
    const lagging = (await t.app.inject({ method: 'GET', url: '/health/ready' })).json();
    expect(lagging).toMatchObject({
      status: 'degraded',
      checks: { indexer: { ok: false, lagLedgers: 991, treasuries: 1 } },
    });
  });

  it('readiness returns 503 when the database is down', async () => {
    const broken = await createTestDatabase();
    const app = await createTestApp(broken.db, broken.url);
    await broken.destroy(); // drops the database under the app
    const res = await app.app.inject({ method: 'GET', url: '/health/ready' });
    await app.app.close().catch(() => undefined);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'unavailable', checks: { database: { ok: false } } });
  });
});

describe('platform behaviour', () => {
  it('protects /metrics with a bearer token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const res = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token-1234567890' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('stellarsafe_http_request_duration_seconds');
    expect(res.body).toContain('stellarsafe_indexer_events_total');
  });

  it('returns a consistent error envelope for unknown routes and bad JSON', async () => {
    const missing = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND', requestId: expect.any(String) } });
    const bad = await t.app.inject({
      method: 'POST',
      url: '/auth/challenge',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBeTruthy();
  });

  it('propagates safe request ids and generates one otherwise', async () => {
    const echoed = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-123' },
    });
    expect(echoed.headers['x-request-id']).toBe('trace-123');
    const unsafe = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id\n' },
    });
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers and honours the CORS allowlist', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.stellarsafe.test' },
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['access-control-allow-origin']).toBe('https://app.stellarsafe.test');
    const evil = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects oversized bodies', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/challenge',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ account: 'x'.repeat(100_000) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('serves a complete OpenAPI 3.1 document', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    for (const path of [
      '/auth/challenge',
      '/auth/verify',
      '/treasuries',
      '/treasuries/{id}',
      '/treasuries/{id}/members',
      '/treasuries/{id}/proposals',
      '/treasuries/{id}/activity',
      '/notifications/preferences',
      '/health',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
    expect(doc.paths['/metrics']).toBeUndefined();
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Treasury', 'Proposal', 'Error']),
    );
  });
});

describe('operations', () => {
  it('reprojection rebuilds the read model from stored events without re-notifying', async () => {
    const id = randomContractId();
    t.chain.wasmHashes.set(id, 'aa'.repeat(32));
    const s = await login(t.app);
    await t.app.inject({
      method: 'POST',
      url: '/treasuries',
      headers: s.headers,
      payload: { contractId: id, startLedger: 1 },
    });
    const f = new EventFactory(id, 50);
    const alice = randomAccount();
    t.chain.events.push(
      f.init([alice], 1),
      f.proposed({ id: 1, proposer: alice, recipient: alice, token: id, amount: 9 }),
      f.approved(1, alice, 1),
    );
    const ix = new Indexer(tdb.db, t.chain, createLogger('silent', false), {
      windowLedgers: 10_000,
      pollIntervalMs: 1,
    });
    while ((await ix.tick()).behind);

    // Corrupt the projection, then rebuild it.
    await tdb.db.updateTable('proposals').set({ approvals_count: 99, amount: '1' }).execute();
    await tdb.db.deleteFrom('treasury_members').where('contract_id', '=', id).execute();
    const outboxBefore = await tdb.db.selectFrom('notification_outbox').select('id').execute();

    const stats = await reprojectTreasury(tdb.db, id);
    expect(stats).toEqual({ events: 3, applied: 3, invalid: 0 });
    const p = (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/proposals/1` })).json();
    expect(p).toMatchObject({ amount: '9', approvalsCount: 1 });
    expect((await t.app.inject({ method: 'GET', url: `/treasuries/${id}` })).json().memberCount).toBe(1);
    expect(await tdb.db.selectFrom('notification_outbox').select('id').execute()).toHaveLength(
      outboxBefore.length,
    );
    const activity = (await t.app.inject({ method: 'GET', url: `/treasuries/${id}/activity` })).json();
    expect(activity.items.filter((a: { source: string }) => a.source === 'chain')).toHaveLength(3);
    expect(activity.items.filter((a: { source: string }) => a.source === 'api')).toHaveLength(1);
  });

  it('maintenance prunes expired auth state', async () => {
    await login(t.app);
    await sql`UPDATE auth_challenges SET expires_at = now() - interval '2 days'`.execute(tdb.db);
    await sql`UPDATE refresh_tokens SET expires_at = now() - interval '8 days'`.execute(tdb.db);
    await runMaintenance(tdb.db);
    expect(await tdb.db.selectFrom('auth_challenges').select('id').execute()).toHaveLength(0);
    expect(await tdb.db.selectFrom('refresh_tokens').select('id').execute()).toHaveLength(0);
  });

  it('workers start and stop cleanly', async () => {
    const workers = createWorkers(t.config, tdb.db, t.chain, createLogger('silent', false));
    workers.start();
    workers.start(); // idempotent
    await new Promise((r) => setTimeout(r, 50));
    await workers.stop();
  });
});
