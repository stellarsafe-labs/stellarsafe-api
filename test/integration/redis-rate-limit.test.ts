import { Keypair } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { testConfig } from '../helpers/config.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { FakeChain } from '../helpers/fake-chain.js';

let tdb: TestDatabase;
let container: StartedTestContainer;
let redisUrl: string;

beforeAll(async () => {
  tdb = await createTestDatabase();
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
});
afterAll(async () => {
  await container?.stop();
  await tdb.destroy();
});

const replica = async (redis: Redis) => {
  const app = await buildApp({
    config: testConfig(tdb.url, { RATE_LIMIT_AUTH_MAX: '3', REDIS_URL: redisUrl }),
    db: tdb.db,
    chain: new FakeChain(),
    redis,
  });
  await app.ready();
  return app;
};

const challenge = (app: Awaited<ReturnType<typeof replica>>, ip: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/challenge',
    payload: { account: Keypair.random().publicKey() },
    remoteAddress: ip,
  });

describe('redis-backed rate limiting', () => {
  it('shares one budget across replicas', async () => {
    const r1 = new Redis(redisUrl);
    const r2 = new Redis(redisUrl);
    const [a, b] = [await replica(r1), await replica(r2)];
    const codes = [];
    for (const app of [a, b, a, b]) codes.push((await challenge(app, '203.0.113.7')).statusCode);
    // A different client IP has its own budget.
    const other = (await challenge(b, '203.0.113.8')).statusCode;
    await Promise.all([a.close(), b.close()]);
    r1.disconnect();
    r2.disconnect();
    expect(codes).toEqual([201, 201, 201, 429]);
    expect(other).toBe(201);
  });

  it('fails open and reports degraded readiness when redis is down', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    const app = await replica(dead);
    const res = await challenge(app, '203.0.113.9');
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    await app.close();
    dead.disconnect();
    expect(res.statusCode).toBe(201);
    expect(ready.json()).toMatchObject({ status: 'degraded', checks: { redis: { ok: false } } });
  });
});
