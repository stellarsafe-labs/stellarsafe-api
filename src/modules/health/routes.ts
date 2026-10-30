import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import type { ChainClient } from '../../chain/chain-client.js';
import type { Config } from '../../config.js';
import type { DB } from '../../db/index.js';
import { safeEqual } from '../../lib/crypto.js';
import { unauthorized } from '../../lib/errors.js';
import { registry } from '../../lib/metrics.js';

const check = z.object({ ok: z.boolean(), latencyMs: z.number().optional(), error: z.string().optional() });

export const healthRoutes: FastifyPluginAsyncZod<{
  db: DB;
  chain: ChainClient;
  config: Config;
  version: string;
}> = async (app, { db, chain, config, version }) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        response: {
          200: z.object({ status: z.literal('ok'), version: z.string(), uptimeSeconds: z.number() }),
        },
      },
    },
    async () => ({ status: 'ok' as const, version, uptimeSeconds: Math.round(process.uptime()) }),
  );

  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Readiness probe: database, RPC and indexer lag',
        description:
          'Returns 503 when the database is unreachable. RPC or indexer problems are reported as `degraded`.',
        response: {
          '2xx': z.object({
            status: z.enum(['ok', 'degraded', 'unavailable']),
            network: z.string(),
            checks: z.object({
              database: check,
              rpc: check.extend({ latestLedger: z.number().optional() }),
              indexer: check.extend({ lagLedgers: z.number().optional(), treasuries: z.number().optional() }),
            }),
          }),
          503: z.unknown(),
        },
      },
    },
    async (_req, reply) => {
      const timed = async <T>(fn: () => Promise<T>) => {
        const t0 = performance.now();
        try {
          return { ok: true as const, value: await fn(), latencyMs: Math.round(performance.now() - t0) };
        } catch (err) {
          return {
            ok: false as const,
            error: (err as Error).message,
            latencyMs: Math.round(performance.now() - t0),
          };
        }
      };

      const [dbr, rpcr] = await Promise.all([
        timed(() => sql`SELECT 1`.execute(db)),
        timed(() => chain.getLedgerBounds()),
      ]);
      const database = dbr.ok
        ? { ok: true, latencyMs: dbr.latencyMs }
        : { ok: false, error: 'database unreachable' };
      const rpc = rpcr.ok
        ? { ok: true, latencyMs: rpcr.latencyMs, latestLedger: rpcr.value.latestLedger }
        : { ok: false, error: 'rpc unreachable', latencyMs: rpcr.latencyMs };

      let indexer: z.infer<typeof check> & { lagLedgers?: number; treasuries?: number } = {
        ok: false,
        error: 'unknown',
      };
      if (dbr.ok && rpcr.ok) {
        const row = await db
          .selectFrom('treasuries')
          .select((eb) => [eb.fn.min('last_indexed_ledger').as('min'), eb.fn.countAll<string>().as('count')])
          .executeTakeFirst();
        const count = Number(row?.count ?? 0);
        const lag = count === 0 ? 0 : rpcr.value.latestLedger - Number(row?.min ?? 0);
        indexer = { ok: lag <= config.INDEXER_MAX_LAG_LEDGERS, lagLedgers: lag, treasuries: count };
      }

      const status = !database.ok ? 'unavailable' : rpc.ok && indexer.ok ? 'ok' : 'degraded';
      return reply
        .status(status === 'unavailable' ? 503 : 200)
        .send({ status, network: config.STELLAR_NETWORK, checks: { database, rpc, indexer } });
    },
  );

  app.get('/metrics', { config: { rateLimit: false }, schema: { hide: true } }, async (req, reply) => {
    if (config.METRICS_TOKEN) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      if (!safeEqual(token, config.METRICS_TOKEN)) throw unauthorized('Invalid metrics token');
    }
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });
};
