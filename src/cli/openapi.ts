/** Writes openapi.json (used by stellarsafe-sdk codegen; CI fails if it is stale). */
import { writeFileSync } from 'node:fs';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import type { ChainClient } from '../chain/chain-client.js';

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://unused/unused',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  JWT_SECRET: 'x'.repeat(32),
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  PUBLIC_URL: 'https://api.stellarsafe.example',
});
const db = createDb({ connectionString: config.DATABASE_URL });
const app = await buildApp({ config, db, chain: {} as ChainClient });
await app.ready();
const out = process.argv[2] ?? 'openapi.json';
writeFileSync(out, JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
await db.destroy();
console.log(`wrote ${out}`);
