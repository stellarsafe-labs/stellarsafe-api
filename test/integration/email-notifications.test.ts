import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { SecretBox } from '../../src/lib/crypto.js';
import { createLogger } from '../../src/lib/logger.js';
import { NotificationDispatcher } from '../../src/modules/notifications/dispatcher.js';
import type { MailMessage } from '../../src/modules/notifications/mailer.js';
import { sendWebhook } from '../../src/modules/notifications/sender.js';
import { createTestApp, login, type TestApp } from '../helpers/app.js';
import { createTestDatabase, truncateAll, type TestDatabase } from '../helpers/db.js';
import { EventFactory, randomAccount, randomContractId } from '../helpers/events.js';

let tdb: TestDatabase;
let t: TestApp;
let sent: MailMessage[] = [];
let mailerFails = 0;
const log = createLogger('silent', false);

beforeAll(async () => {
  tdb = await createTestDatabase();
  t = await createTestApp(tdb.db, tdb.url, { SMTP_URL: 'smtp://mail.invalid:2525' });
});
afterAll(async () => {
  await t.app.close();
  await tdb.destroy();
});
beforeEach(async () => {
  await truncateAll(tdb.db);
  t.chain.events = [];
  sent = [];
  mailerFails = 0;
});

const dispatcher = () =>
  new NotificationDispatcher(tdb.db, new SecretBox(t.config.SECRETS_ENCRYPTION_KEY), sendWebhook, log, {
    pollIntervalMs: 10,
    maxAttempts: 3,
    timeoutMs: 1_000,
    disableAfterFailures: 5,
    allowPrivateTargets: true,
    publicUrl: t.config.PUBLIC_URL,
    mailer: async (msg) => {
      if (mailerFails > 0) {
        mailerFails--;
        throw new Error('SMTP 451 try again later');
      }
      sent.push(msg);
    },
  });

async function flush() {
  const d = dispatcher();
  for (let i = 0; i < 10; i++) {
    await d.fanOut();
    await sql`UPDATE notification_deliveries SET next_attempt_at = now() WHERE status = 'pending'`.execute(
      tdb.db,
    );
    if ((await d.deliverDue()) === 0) return;
  }
}

async function setup() {
  const member = await login(t.app);
  const id = randomContractId();
  t.chain.wasmHashes.set(id, 'aa'.repeat(32));
  t.chain.latestLedger = 20;
  await t.app.inject({
    method: 'POST',
    url: '/treasuries',
    headers: member.headers,
    payload: { contractId: id, startLedger: 1 },
  });
  const f = new EventFactory(id, 10);
  t.chain.events.push(f.init([member.account], 1));
  await index();
  return { id, f, member };
}

async function index() {
  const ix = new Indexer(tdb.db, t.chain, log, { windowLedgers: 10_000, pollIntervalMs: 1 });
  while ((await ix.tick()).behind);
}

const subscribeEmail = (headers: Record<string, string>, email: string) =>
  t.app.inject({
    method: 'POST',
    url: '/notifications/preferences',
    headers,
    payload: { channel: 'email', email },
  });

const tokenFrom = (msg: MailMessage, path: 'verify' | 'unsubscribe') =>
  decodeURIComponent(new RegExp(`/notifications/email/${path}\\?token=([^\\s>]+)`).exec(msg.text)![1]!);

const form = (url: string, body: string) =>
  t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: body,
  });

describe('email notifications (double opt-in)', () => {
  it('is refused when SMTP is not configured', async () => {
    const plain = await createTestApp(tdb.db, tdb.url);
    const s = await login(plain.app);
    const res = await plain.app.inject({
      method: 'POST',
      url: '/notifications/preferences',
      headers: s.headers,
      payload: { channel: 'email', email: 'a@example.com' },
    });
    await plain.app.close();
    expect(res.statusCode).toBe(400);
  });

  it('sends nothing until the address is confirmed, then delivers events', async () => {
    const { id, f, member } = await setup();
    const res = await subscribeEmail(member.headers, 'Treasurer@Example.com');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ channel: 'email', email: 'treasurer@example.com', verified: false });
    expect(res.json().secret).toBeUndefined();

    // An event before confirmation must not be emailed.
    t.chain.latestLedger = 30;
    f.ledger = 25;
    t.chain.events.push(
      f.proposed({ id: 1, proposer: member.account, recipient: randomAccount(), token: id, amount: 5 }),
    );
    await index();
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('Confirm');
    const token = tokenFrom(sent[0]!, 'verify');

    // GET only shows a page (link scanners must not confirm on their own).
    const page = await t.app.inject({ method: 'GET', url: `/notifications/email/verify?token=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<form method="post"');
    const still = await tdb.db
      .selectFrom('notification_subscriptions')
      .select('verified_at')
      .executeTakeFirstOrThrow();
    expect(still.verified_at).toBeNull();

    const confirm = await form('/notifications/email/verify', `token=${encodeURIComponent(token)}`);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('Email confirmed');
    // Single use.
    expect((await form('/notifications/email/verify', `token=${encodeURIComponent(token)}`)).statusCode).toBe(
      400,
    );

    sent = [];
    t.chain.latestLedger = 40;
    f.ledger = 35;
    t.chain.events.push(f.approved(1, member.account, 1));
    await index();
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'treasurer@example.com' });
    expect(sent[0]!.subject).toContain('Proposal #1');
    expect(sent[0]!.text).toContain('verify proposal details on-chain');
    expect(sent[0]!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('supports RFC 8058 one-click unsubscribe and rejects forged tokens', async () => {
    const { member } = await setup();
    const sub = (await subscribeEmail(member.headers, 'ops@example.com')).json();
    await flush();
    await form('/notifications/email/verify', `token=${encodeURIComponent(tokenFrom(sent[0]!, 'verify'))}`);
    sent = [];
    await t.app.inject({
      method: 'POST',
      url: `/notifications/preferences/${sub.id}/test`,
      headers: member.headers,
    });
    await flush();
    const unsub = tokenFrom(sent[0]!, 'unsubscribe');

    const forged = `${sub.id}.${'A'.repeat(43)}`;
    expect(
      (
        await form(
          `/notifications/email/unsubscribe?token=${encodeURIComponent(forged)}`,
          'List-Unsubscribe=One-Click',
        )
      ).statusCode,
    ).toBe(400);

    const ok = await form(
      `/notifications/email/unsubscribe?token=${encodeURIComponent(unsub)}`,
      'List-Unsubscribe=One-Click',
    );
    expect(ok.statusCode).toBe(200);
    const row = await tdb.db.selectFrom('notification_subscriptions').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ enabled: false, disabled_reason: 'unsubscribed via email link' });
  });

  it('expires tokens, and resending invalidates the previous link', async () => {
    const { member } = await setup();
    const sub = (await subscribeEmail(member.headers, 'a@example.com')).json();
    await flush();
    const first = tokenFrom(sent[0]!, 'verify');

    const resend = await t.app.inject({
      method: 'POST',
      url: `/notifications/preferences/${sub.id}/resend-verification`,
      headers: member.headers,
    });
    expect(resend.statusCode).toBe(202);
    await flush();
    const second = tokenFrom(sent[1]!, 'verify');
    expect((await form('/notifications/email/verify', `token=${encodeURIComponent(first)}`)).statusCode).toBe(
      400,
    );

    await sql`UPDATE notification_subscriptions SET verification_expires_at = now() - interval '1 second'`.execute(
      tdb.db,
    );
    expect(
      (await form('/notifications/email/verify', `token=${encodeURIComponent(second)}`)).statusCode,
    ).toBe(400);
  });

  it('retries transient SMTP failures', async () => {
    const { member } = await setup();
    mailerFails = 2;
    await subscribeEmail(member.headers, 'a@example.com');
    await flush();
    expect(sent).toHaveLength(1);
    const d = await tdb.db.selectFrom('notification_deliveries').selectAll().executeTakeFirstOrThrow();
    expect(d).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('applies channel rules', async () => {
    const { member } = await setup();
    const sub = (await subscribeEmail(member.headers, 'a@example.com')).json();
    const call = (method: 'POST' | 'PATCH', url: string, payload?: object) =>
      t.app.inject({ method, url, headers: member.headers, payload });
    expect((await call('POST', `/notifications/preferences/${sub.id}/test`)).statusCode).toBe(409);
    expect((await call('POST', `/notifications/preferences/${sub.id}/rotate-secret`)).statusCode).toBe(400);
    expect(
      (await call('PATCH', `/notifications/preferences/${sub.id}`, { url: 'https://x.io' })).statusCode,
    ).toBe(400);
    expect((await call('POST', '/notifications/preferences', { channel: 'email' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/notifications/preferences', { channel: 'email', email: 'nope' })).statusCode,
    ).toBe(400);
    expect((await call('POST', '/notifications/preferences', { channel: 'webhook' })).statusCode).toBe(400);
  });

  it('escapes tokens rendered into HTML', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/notifications/email/verify?token=${encodeURIComponent('"><script>alert(1)</script>')}`,
    });
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&#34;&#62;&#60;script&#62;');
  });
});
