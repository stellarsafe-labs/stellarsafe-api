import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createLogger } from './lib/logger.js';
import { createChainClient, createWorkers } from './workers.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, !config.isProduction);
const db = createDb({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  ssl: config.DATABASE_SSL,
  applicationName: 'stellarsafe-worker',
});
const workers = createWorkers(config, db, createChainClient(config), log);

closeWithGrace({ delay: 30_000 }, async ({ signal, err }) => {
  if (err) log.error({ err }, 'worker shutting down after error');
  else log.info({ signal }, 'worker shutting down');
  await workers.stop();
  await db.destroy();
});

workers.start();
log.info({ network: config.STELLAR_NETWORK }, 'stellarsafe-worker running');
