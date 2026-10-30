import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { SecretBox } from '../../src/lib/crypto.js';
import { createLogger } from '../../src/lib/logger.js';
import { NotificationDispatcher } from '../../src/modules/notifications/dispatcher.js';
import { sendWebhook } from '../../src/modules/notifications/sender.js';
import { createTestApp, login, type TestApp } from '../helpers/app.js';
import { createTestDatabase, truncateAll, type TestDatabase } from '../helpers/db.js';
import { EventFactory, randomAccount, randomContractId } from '../helpers/events.js';

let tdb: TestDatabase;
let t: TestApp;
let server: Server;
let hookUrl: string;
let received: { headers: IncomingHttpHeaders; body: string; path: string }[] = [];
let respond: (path: string) => { status: number; headers?: Record<string, string> } = () => ({ status: 200 });
const log = createLogger('silent', false);

beforeAll(async () => {
  tdb = await createTestDatabase();
  t = await createTestApp(tdb.db, tdb.url);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body, path: req.url ?? '' });
      const r = respond(req.url ?? '');
      res.writeHead(r.status, r.headers).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await t.app.close();
  await tdb.destroy();
});
beforeEach(async () => {
  await truncateAll(tdb.db);
  t.chain.events = [];
  received = [];
  respond = () => ({ status: 200 });
});

const dispatcher = (overrides: Partial<ConstructorParameters<typeof NotificationDispatcher>[4]> = {}) =>
  new NotificationDispatcher(tdb.db, new SecretBox(t.config.SECRETS_ENCRYPTION_KEY), sendWebhook, log, {
    pollIntervalMs: 10,
    maxAttempts: 3,
    timeoutMs: 2_000,
    disableAfterFailures: 2,
    allowPrivateTargets: true,
    ...overrides,
  });

const indexAll = async () => {
  const ix = new Indexer(tdb.db, t.chain, log, { windowLedgers: 10_000, pollIntervalMs: 1 });
  while ((await ix.tick()).behind);
};

async function setup() {
  const member = await login(t.app);
  const id = randomContractId();
  t.chain.wasmHashes.set(id, 'aa'.repeat(32));
  await t.app.inject({
    method: 'POST',
    url: '/treasuries',
    headers: member.headers,
    payload: { contractId: id, startLedger: 1 },
  });
  const f = new EventFactory(id, 10);
  t.chain.latestLedger = 20;
  t.chain.events.push(f.init([member.account], 1));
  await indexAll();
  return { id, f, member };
}

let ip = 0;
/** The test endpoint is rate limited per IP; give each call its own client address. */
const ping = (subId: string, headers: Record<string, string>) =>
  t.app.inject({
    method: 'POST',
    url: `/notifications/preferences/${subId}/test`,
    headers,
    remoteAddress: `10.9.${Math.floor(++ip / 250)}.${ip % 250}`,
  });

const subscribe = (headers: Record<string, string>, payload: object) =>
  t.app.inject({ method: 'POST', url: '/notifications/preferences', headers, payload });

/** Runs fan-out + delivery until nothing is due. Retries are made due immediately. */
async function flush(d = dispatcher()) {
  for (let i = 0; i < 10; i++) {
    await d.fanOut();
    await sql`UPDATE notification_deliveries SET next_attempt_at = now() WHERE status = 'pending'`.execute(
      tdb.db,
    );
    if ((await d.deliverDue()) === 0) return;
  }
}

describe('subscription management', () => {
  it('creates, lists, updates, rotates and deletes subscriptions', async () => {
    const { id, member } = await setup();
    const created = await subscribe(member.headers, {
      url: `${hookUrl}/a`,
      treasuryId: id,
      eventTypes: ['proposal.created', 'proposal.executed'],
    });
    expect(created.statusCode).toBe(201);
    const sub = created.json();
    expect(sub.secret).toMatch(/^whsec_/);
    expect(sub).toMatchObject({ channel: 'webhook', format: 'json', enabled: true, treasuryId: id });

    const list = (
      await t.app.inject({ method: 'GET', url: '/notifications/preferences', headers: member.headers })
    ).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].secret).toBeUndefined();

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/notifications/preferences/${sub.id}`,
      headers: member.headers,
      payload: { format: 'slack', enabled: false },
    });
    expect(patched.json()).toMatchObject({ format: 'slack', enabled: false });

    const rotated = await t.app.inject({
      method: 'POST',
      url: `/notifications/preferences/${sub.id}/rotate-secret`,
      headers: member.headers,
    });
    expect(rotated.json().secret).not.toBe(sub.secret);

    const stored = await tdb.db
      .selectFrom('notification_subscriptions')
      .select('secret_encrypted')
      .executeTakeFirstOrThrow();
    expect(stored.secret_encrypted).not.toContain('whsec_');

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/notifications/preferences/${sub.id}`,
      headers: member.headers,
    });
    expect(del.statusCode).toBe(204);
  });

  it("isolates accounts: you cannot see or change someone else's subscription", async () => {
    const { member } = await setup();
    const sub = (await subscribe(member.headers, { url: hookUrl })).json();
    const other = await login(t.app);
    for (const [method, url] of [
      ['PATCH', `/notifications/preferences/${sub.id}`],
      ['DELETE', `/notifications/preferences/${sub.id}`],
      ['POST', `/notifications/preferences/${sub.id}/test`],
      ['POST', `/notifications/preferences/${sub.id}/rotate-secret`],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: other.headers,
        payload: method === 'PATCH' ? {} : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const list = (
      await t.app.inject({ method: 'GET', url: '/notifications/preferences', headers: other.headers })
    ).json();
    expect(list.items).toEqual([]);
  });

  it('requires membership to subscribe to a specific treasury', async () => {
    const { id } = await setup();
    const outsider = await login(t.app);
    expect((await subscribe(outsider.headers, { url: hookUrl, treasuryId: id })).statusCode).toBe(403);
  });

  it('validates event types and requires auth', async () => {
    const { member } = await setup();
    expect((await subscribe(member.headers, { url: hookUrl, eventTypes: ['nope'] })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/notifications/preferences' })).statusCode).toBe(401);
  });

  it('blocks SSRF targets when private targets are not allowed', async () => {
    const strict = await createTestApp(tdb.db, tdb.url, { NOTIFY_ALLOW_PRIVATE_TARGETS: 'false' });
    const s = await login(strict.app);
    const res = await strict.app.inject({
      method: 'POST',
      url: '/notifications/preferences',
      headers: s.headers,
      payload: { url: 'http://169.254.169.254/latest/meta-data' },
    });
    await strict.app.close();
    expect(res.statusCode).toBe(400);
  });

  it('caps subscriptions per account', async () => {
    const { member } = await setup();
    for (let i = 0; i < 20; i++)
      expect((await subscribe(member.headers, { url: `${hookUrl}/${i}` })).statusCode).toBe(201);
    expect((await subscribe(member.headers, { url: hookUrl })).statusCode).toBe(400);
  });
});

describe('delivery', () => {
  it('delivers signed webhooks for matching events to members only', async () => {
    const { id, f, member } = await setup();
    const sub = (
      await subscribe(member.headers, { url: `${hookUrl}/member`, eventTypes: ['proposal.created'] })
    ).json();
    const outsider = await login(t.app);
    await subscribe(outsider.headers, { url: `${hookUrl}/outsider` });

    f.ledger = 21;
    t.chain.latestLedger = 30;
    t.chain.events.push(
      f.proposed({ id: 1, proposer: member.account, recipient: randomAccount(), token: id, amount: 42 }),
      f.approved(1, member.account, 1),
    );
    await indexAll();
    await flush();

    expect(received.map((r) => r.path)).toEqual(['/member']);
    const [hit] = received;
    expect(hit!.headers['x-stellarsafe-event']).toBe('proposal.created');
    const sig = String(hit!.headers['x-stellarsafe-signature']);
    const [, ts, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig)!;
    expect(createHmac('sha256', sub.secret).update(`${ts}.${hit!.body}`).digest('hex')).toBe(v1);
    const body = JSON.parse(hit!.body);
    expect(body).toMatchObject({
      type: 'proposal.created',
      payload: { treasuryId: id, data: { id: '1', amount: '42' } },
    });
    expect(body.id).toBe(hit!.headers['x-stellarsafe-delivery']);

    const log = (
      await t.app.inject({ method: 'GET', url: '/notifications/deliveries', headers: member.headers })
    ).json();
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ status: 'succeeded', attempts: 1, lastStatusCode: 200 });
  });

  it('retries with backoff, then dead-letters and auto-disables', async () => {
    const { member } = await setup();
    respond = () => ({ status: 500 });
    const sub = (await subscribe(member.headers, { url: `${hookUrl}/flaky` })).json();
    await ping(sub.id, member.headers);
    await ping(sub.id, member.headers);
    await flush();

    expect(received).toHaveLength(6); // 2 deliveries x 3 attempts
    const deliveries = (
      await t.app.inject({
        method: 'GET',
        url: '/notifications/deliveries?status=dead',
        headers: member.headers,
      })
    ).json();
    expect(deliveries.items).toHaveLength(2);
    expect(deliveries.items[0]).toMatchObject({ attempts: 3, lastStatusCode: 500, lastError: 'HTTP 500' });

    const s = (
      await t.app.inject({ method: 'GET', url: '/notifications/preferences', headers: member.headers })
    ).json().items[0];
    expect(s).toMatchObject({ enabled: false, consecutiveFailures: 2 });
    expect(s.disabledReason).toContain('consecutive failed deliveries');

    // Re-enabling resets the counter.
    const re = await t.app.inject({
      method: 'PATCH',
      url: `/notifications/preferences/${sub.id}`,
      headers: member.headers,
      payload: { enabled: true },
    });
    expect(re.json()).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null });
  });

  it('schedules the retry using backoff and Retry-After', async () => {
    const { member } = await setup();
    respond = () => ({ status: 429, headers: { 'retry-after': '3600' } });
    const sub = (await subscribe(member.headers, { url: hookUrl })).json();
    await ping(sub.id, member.headers);
    await dispatcher().deliverDue();
    const row = await tdb.db.selectFrom('notification_deliveries').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(3500_000);
  });

  it('disables immediately on 410 Gone', async () => {
    const { member } = await setup();
    respond = () => ({ status: 410 });
    const sub = (await subscribe(member.headers, { url: hookUrl })).json();
    await ping(sub.id, member.headers);
    await flush();
    expect(received).toHaveLength(1);
    const s = await tdb.db.selectFrom('notification_subscriptions').selectAll().executeTakeFirstOrThrow();
    expect(s.enabled).toBe(false);
    expect(s.disabled_reason).toContain('410');
  });

  it('formats Slack and Discord payloads', async () => {
    const { member } = await setup();
    const slack = (await subscribe(member.headers, { url: `${hookUrl}/slack`, format: 'slack' })).json();
    const discord = (
      await subscribe(member.headers, { url: `${hookUrl}/discord`, format: 'discord' })
    ).json();
    for (const s of [slack, discord]) {
      await ping(s.id, member.headers);
    }
    await flush();
    const byPath = Object.fromEntries(received.map((r) => [r.path, JSON.parse(r.body)]));
    expect(byPath['/slack'].text).toContain('StellarSafe test notification');
    expect(byPath['/discord'].content).toContain('StellarSafe test notification');
  });

  it('refuses to deliver to private addresses at send time (DNS rebinding safe)', async () => {
    const { member } = await setup();
    const sub = (await subscribe(member.headers, { url: hookUrl })).json();
    await ping(sub.id, member.headers);
    await dispatcher({ allowPrivateTargets: false, maxAttempts: 1 }).deliverDue();
    expect(received).toHaveLength(0);
    const row = await tdb.db.selectFrom('notification_deliveries').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('dead');
    expect(row.last_error).toContain('non-public');
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    const result = await sendWebhook({
      url: `http://localhost:${new URL(hookUrl).port}/`,
      body: '{}',
      secret: 's',
      eventType: 'ping',
      deliveryId: 'd',
      timeoutMs: 1000,
      allowPrivate: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('non-public');
    expect(received).toHaveLength(0);
  });

  it('times out slow receivers', async () => {
    const slow = createServer(() => undefined);
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const result = await sendWebhook({
      url: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/`,
      body: '{}',
      secret: 's',
      eventType: 'ping',
      deliveryId: 'd',
      timeoutMs: 200,
      allowPrivate: true,
    });
    slow.closeAllConnections();
    slow.close();
    expect(result).toMatchObject({ ok: false, statusCode: null });
    expect(result.error).toContain('timed out');
  });

  it('reclaims deliveries whose lease expired (crashed worker)', async () => {
    const { member } = await setup();
    const sub = (await subscribe(member.headers, { url: hookUrl })).json();
    await ping(sub.id, member.headers);
    await sql`UPDATE notification_deliveries SET status = 'in_flight', attempts = 1, lease_expires_at = now() - interval '1 second'`.execute(
      tdb.db,
    );
    await dispatcher().deliverDue();
    const row = await tdb.db.selectFrom('notification_deliveries').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('runs as a background loop', async () => {
    const { member } = await setup();
    const sub = (await subscribe(member.headers, { url: hookUrl })).json();
    await ping(sub.id, member.headers);
    const d = dispatcher();
    d.start();
    for (let i = 0; i < 100 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await d.stop();
    expect(received).toHaveLength(1);
  });
});
