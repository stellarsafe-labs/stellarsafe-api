import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, login, signSep53, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let tdb: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  tdb = await createTestDatabase();
  t = await createTestApp(tdb.db, tdb.url, { RATE_LIMIT_AUTH_MAX: '1000' });
});
afterAll(async () => {
  await t.app.close();
  await tdb.destroy();
});

const challenge = async (account: string, mode?: 'message' | 'transaction') =>
  t.app.inject({ method: 'POST', url: '/auth/challenge', payload: { account, ...(mode ? { mode } : {}) } });

describe('SEP-53 message sign-in', () => {
  it('issues a human-readable, domain-bound challenge', async () => {
    const kp = Keypair.random();
    const res = await challenge(kp.publicKey());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mode).toBe('message');
    expect(body.message).toContain('api.stellarsafe.test wants you to sign in with your Stellar account:');
    expect(body.message).toContain(kp.publicKey());
    expect(body.message).toContain(`Nonce: ${body.challengeId}`);
    expect(body.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('exchanges a valid signature for tokens that authenticate /auth/me', async () => {
    const { account, headers, accessToken, refreshToken } = await login(t.app);
    expect(accessToken).toMatch(/^ey/);
    expect(refreshToken).toBeTruthy();
    const me = await t.app.inject({ method: 'GET', url: '/auth/me', headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ account });
  });

  it('rejects a replayed challenge', async () => {
    const kp = Keypair.random();
    const { challengeId, message } = (await challenge(kp.publicKey())).json();
    const payload = { challengeId, signature: signSep53(kp, message) };
    expect((await t.app.inject({ method: 'POST', url: '/auth/verify', payload })).statusCode).toBe(200);
    const replay = await t.app.inject({ method: 'POST', url: '/auth/verify', payload });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a signature from a different wallet', async () => {
    const kp = Keypair.random();
    const { challengeId, message } = (await challenge(kp.publicKey())).json();
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, signature: signSep53(Keypair.random(), message) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not burn the challenge on a bad signature', async () => {
    const kp = Keypair.random();
    const { challengeId, message } = (await challenge(kp.publicKey())).json();
    await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, signature: signSep53(Keypair.random(), message) },
    });
    const ok = await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, signature: signSep53(kp, message) },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects expired challenges', async () => {
    const kp = Keypair.random();
    const { challengeId, message } = (await challenge(kp.publicKey())).json();
    await sql`UPDATE auth_challenges SET expires_at = now() - interval '1 second' WHERE id = ${challengeId}`.execute(
      tdb.db,
    );
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, signature: signSep53(kp, message) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('only one of many concurrent verifications succeeds', async () => {
    const kp = Keypair.random();
    const { challengeId, message } = (await challenge(kp.publicKey())).json();
    const payload = { challengeId, signature: signSep53(kp, message) };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => t.app.inject({ method: 'POST', url: '/auth/verify', payload })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('validates input', async () => {
    const bad = await challenge('GNOTANACCOUNT');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    const contract = await challenge('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
    expect(contract.statusCode).toBe(400);
    const missing = await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe('SEP-10 transaction sign-in', () => {
  it('signs in with a signed challenge transaction', async () => {
    const kp = Keypair.random();
    const res = await challenge(kp.publicKey(), 'transaction');
    expect(res.statusCode).toBe(201);
    const { challengeId, transaction, networkPassphrase } = res.json();
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(kp);
    const verify = await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, signedTransaction: tx.toXDR() },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().account).toBe(kp.publicKey());
  });

  it('rejects an unsigned challenge transaction', async () => {
    const kp = Keypair.random();
    const { challengeId, transaction } = (await challenge(kp.publicKey(), 'transaction')).json();
    const verify = await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, signedTransaction: transaction },
    });
    expect(verify.statusCode).toBe(401);
  });

  it('requires the proof that matches the challenge mode', async () => {
    const kp = Keypair.random();
    const { challengeId } = (await challenge(kp.publicKey(), 'transaction')).json();
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, signature: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('advertises supported modes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/config' });
    expect(res.json()).toMatchObject({
      modes: ['message', 'transaction'],
      homeDomain: 'api.stellarsafe.test',
    });
  });
});

describe('sessions', () => {
  it('rotates refresh tokens', async () => {
    const s = await login(t.app);
    const r1 = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().refreshToken).not.toBe(s.refreshToken);
    const r2 = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: r1.json().refreshToken },
    });
    expect(r2.statusCode).toBe(200);
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const s = await login(t.app);
    const rotated = (
      await t.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: s.refreshToken } })
    ).json().refreshToken;
    const reuse = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.message).toContain('reuse');
    const legit = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(legit.statusCode).toBe(401);
  });

  it('logout revokes the session', async () => {
    const s = await login(t.app);
    const out = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: s.refreshToken },
    });
    expect(out.statusCode).toBe(204);
    const r = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    expect(r.statusCode).toBe(401);
    // Unknown tokens are a no-op, not an error (no oracle).
    const again = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'nope' },
    });
    expect(again.statusCode).toBe(204);
  });

  it('rejects expired refresh tokens', async () => {
    const s = await login(t.app);
    await sql`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE account = ${s.account}`.execute(
      tdb.db,
    );
    const r = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    expect(r.statusCode).toBe(401);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'Bearer'],
    ['garbage', 'Bearer abc.def.ghi'],
    ['wrong scheme', 'Basic Zm9vOmJhcg=='],
  ])('rejects %s access tokens', async (_name, authorization) => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authorization ? { authorization } : {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects tokens signed with another secret', async () => {
    const other = await createTestApp(tdb.db, tdb.url, { JWT_SECRET: 'another-secret-another-secret-12345' });
    const s = await login(other.app);
    await other.app.close();
    const res = await t.app.inject({ method: 'GET', url: '/auth/me', headers: s.headers });
    expect(res.statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  it('limits auth endpoints per IP', async () => {
    const limited = await createTestApp(tdb.db, tdb.url, { RATE_LIMIT_AUTH_MAX: '2' });
    const account = Keypair.random().publicKey();
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push(
        (await limited.app.inject({ method: 'POST', url: '/auth/challenge', payload: { account } }))
          .statusCode,
      );
    }
    const last = await limited.app.inject({ method: 'POST', url: '/auth/challenge', payload: { account } });
    await limited.app.close();
    expect(codes).toEqual([201, 201, 429]);
    expect(last.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('without SEP-10 configured', () => {
  it('only offers message mode', async () => {
    const plain = await createTestApp(tdb.db, tdb.url, { SEP10_SIGNING_SECRET: '' });
    const res = await plain.app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { account: Keypair.random().publicKey(), mode: 'transaction' },
    });
    const cfg = await plain.app.inject({ method: 'GET', url: '/auth/config' });
    await plain.app.close();
    expect(res.statusCode).toBe(400);
    expect(cfg.json().modes).toEqual(['message']);
  });
});
