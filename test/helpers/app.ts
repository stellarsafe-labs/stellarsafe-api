import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { DB } from '../../src/db/index.js';
import { sep53Digest } from '../../src/modules/auth/signatures.js';
import { testConfig } from './config.js';
import { FakeChain } from './fake-chain.js';

export interface TestApp {
  app: FastifyInstance;
  chain: FakeChain;
  config: ReturnType<typeof testConfig>;
}

export async function createTestApp(
  db: DB,
  url: string,
  overrides: Record<string, string> = {},
): Promise<TestApp> {
  const config = testConfig(url, overrides);
  const chain = new FakeChain();
  const app = await buildApp({ config, db, chain });
  await app.ready();
  return { app, chain, config };
}

export function signSep53(kp: Keypair, message: string): string {
  return Buffer.from(kp.sign(sep53Digest(message))).toString('base64');
}

/** Full SEP-53 sign-in; returns the bearer header and tokens. */
export async function login(app: FastifyInstance, kp: Keypair = Keypair.random()) {
  const challenge = await app.inject({
    method: 'POST',
    url: '/auth/challenge',
    payload: { account: kp.publicKey() },
  });
  const { challengeId, message } = challenge.json<{ challengeId: string; message: string }>();
  const verify = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { challengeId, signature: signSep53(kp, message) },
  });
  const tokens = verify.json<{ accessToken: string; refreshToken: string }>();
  return {
    kp,
    account: kp.publicKey(),
    headers: { authorization: `Bearer ${tokens.accessToken}` },
    ...tokens,
  };
}
