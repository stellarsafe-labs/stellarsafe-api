import closeWithGrace from 'close-with-grace';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createChainClient, createWorkers } from './workers.js';

const config = loadConfig();
const db = createDb({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  ssl: config.DATABASE_SSL,
  applicationName: 'stellarsafe-api',
});
const chain = createChainClient(config);
const redis = config.REDIS_URL
  ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 })
  : undefined;
const app = await buildApp({ config, db, chain, ...(redis ? { redis } : {}) });
redis?.on('error', (err) => app.log.warn({ err }, 'redis error (rate limiting fails open)'));
const workers = config.RUN_WORKERS ? createWorkers(config, db, chain, app.log) : null;

closeWithGrace({ delay: 15_000 }, async ({ signal, err }) => {
  if (err) app.log.error({ err }, 'shutting down after error');
  else app.log.info({ signal }, 'shutting down');
  await workers?.stop();
  await app.close();
  await db.destroy();
  redis?.disconnect();
});

if (config.isProduction && config.TRUSTED_WASM_HASHES.length === 0) {
  app.log.warn(
    'TRUSTED_WASM_HASHES is empty: any deployed contract can be registered and indexed. Set it to the audited treasury build hash(es).',
  );
}
await app.listen({ host: config.HOST, port: config.PORT });
workers?.start();
app.log.info({ network: config.STELLAR_NETWORK, workers: Boolean(workers) }, 'stellarsafe-api ready');
