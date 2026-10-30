# Performance

## Results

Production build (`NODE_ENV=production`, one Node process, `DATABASE_POOL_MAX=20`) and
Postgres 16 running on the **same 2-vCPU / 8 GB machine**. Each scenario ran 8 s with 50
concurrent connections.

Dataset: 1,000 treasuries (5,000 members), plus one treasury with 20,000 proposals and 100,000
activity rows.

| Scenario                           |  req/s | p50 ms | p99 ms | errors |
| ---------------------------------- | -----: | -----: | -----: | -----: |
| GET /health                        | 12,478 |      3 |     11 |      0 |
| GET /treasuries (page of 25)       |    700 |     66 |    163 |      0 |
| GET /treasuries?member=…           |    836 |     56 |    120 |      0 |
| GET /treasuries/:id                |  1,205 |     39 |     77 |      0 |
| GET proposals?status=pending       |    592 |     79 |    153 |      0 |
| GET proposals/:id (with approvals) |    668 |     71 |    140 |      0 |
| GET activity (100k rows)           |    888 |     53 |     99 |      0 |
| GET activity?type=proposal.\*      |  1,077 |     43 |     93 |      0 |
| POST /auth/challenge (DB write)    |  1,981 |     23 |     54 |      0 |

**Soak test.** 120 s of mixed traffic (5 endpoints, 30 connections), about 113,000 requests at
941 req/s, p99 77 ms. There were 0 errors and no error-level log lines. Memory stayed flat at
420–421 MB for the whole run, so no leak showed up.

## Regression found by load testing

The first run of `GET /treasuries` managed **15 req/s with a 2.7 s median**. Postgres was
seq-scanning `proposals` once per treasury on the page to count pending proposals. Migration
`0003_read_path_indexes` adds a partial index on pending proposals and an index for the list's sort
order. That brought the query from 65 ms down to 0.9 ms and the endpoint up to 700 req/s, about 47× faster.

## Reproducing

```bash
docker run -d --name bench-pg -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:16-alpine
export DATABASE_URL=postgres://postgres:pw@localhost:55433/postgres
npx tsx bench/seed.ts                       # prints {"big": "C…", "member": "G…"}
npm run build
NODE_ENV=production RATE_LIMIT_MAX=100000000 RATE_LIMIT_AUTH_MAX=100000000 \
  STELLAR_RPC_URL=https://soroban-testnet.stellar.org JWT_SECRET=$(openssl rand -base64 48) \
  SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32) PORT=3999 node dist/server.js &
BENCH_URL=http://localhost:3999 BIG=C… MEMBER=G… npx tsx bench/run.ts
```

Rate limits are raised only so the benchmark measures throughput. Keep the defaults in production.

## Caveats

- The database shared 2 CPUs with the API and the load generator. A dedicated database and more
  API replicas scale roughly linearly, since the API is stateless.
- Two minutes isn't weeks. Long-running behaviour (connection churn, table bloat, RPC
  incidents) still needs watching in a staging deployment, using the metrics and alerts in
  [OPERATIONS.md](OPERATIONS.md).
