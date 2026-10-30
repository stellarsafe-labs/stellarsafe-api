/**
 * Runs autocannon against a running API. Usage:
 *   BENCH_URL=http://localhost:3999 BIG=C... MEMBER=G... npx tsx bench/run.ts
 */
import autocannon from 'autocannon';

const base = process.env.BENCH_URL ?? 'http://localhost:3000';
const big = process.env.BIG!;
const member = process.env.MEMBER!;
const duration = Number(process.env.BENCH_SECONDS ?? 10);

const scenarios: { name: string; path: string; method?: 'GET' | 'POST'; body?: string }[] = [
  { name: 'GET /health', path: '/health' },
  { name: 'GET /treasuries (page of 25)', path: '/treasuries' },
  { name: 'GET /treasuries?member=…', path: `/treasuries?member=${member}` },
  { name: 'GET /treasuries/:id', path: `/treasuries/${big}` },
  { name: 'GET proposals?status=pending', path: `/treasuries/${big}/proposals?status=pending` },
  { name: 'GET proposals/:id (with approvals)', path: `/treasuries/${big}/proposals/12345` },
  { name: 'GET activity (100k rows)', path: `/treasuries/${big}/activity?limit=50` },
  { name: 'GET activity?type=proposal.*', path: `/treasuries/${big}/activity?type=proposal.*` },
  {
    name: 'POST /auth/challenge (DB write)',
    path: '/auth/challenge',
    method: 'POST',
    body: JSON.stringify({ account: member }),
  },
];

console.log(`| Scenario | req/s | p50 ms | p99 ms | errors |\n| --- | ---: | ---: | ---: | ---: |`);
for (const s of scenarios) {
  const r = await autocannon({
    url: base + s.path,
    method: s.method ?? 'GET',
    body: s.body,
    headers: s.body ? { 'content-type': 'application/json' } : {},
    connections: 50,
    duration,
  });
  const errors = r.errors + r.timeouts + r.non2xx;
  console.log(
    `| ${s.name} | ${Math.round(r.requests.average)} | ${r.latency.p50} | ${r.latency.p99} | ${errors} |`,
  );
}
