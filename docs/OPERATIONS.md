# Operations

## Processes

The same image runs three roles:

| Role       | Command                    | Scaling                                                                                                 |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| API        | `node dist/server.js`      | Stateless, scale horizontally behind a load balancer                                                    |
| Worker     | `node dist/worker.js`      | One replica is enough. Extra replicas are safe (locks, compare-and-set, `SKIP LOCKED`) but add RPC load |
| Migrations | `node dist/cli/migrate.js` | Run once per deploy, before starting the new version                                                    |

For small deployments, `RUN_WORKERS=true` runs the worker inside the API process.

## Production checklist

- [ ] `NODE_ENV=production` (HTTPS-only webhooks, JSON logs)
- [ ] `JWT_SECRET`: `openssl rand -base64 48`, stored in a secret manager
- [ ] `SECRETS_ENCRYPTION_KEY`: `openssl rand -base64 32`. **Back it up.** Losing it makes webhook secrets unreadable, and subscribers will need new ones.
- [ ] `SEP10_SIGNING_SECRET` (optional): a dedicated, **unfunded** key
- [ ] `PUBLIC_URL` and `AUTH_HOME_DOMAIN` set to the public API domain (these are embedded in sign-in messages)
- [ ] `CORS_ORIGINS` set to the web app's origin(s)
- [ ] `TRUST_PROXY=true` behind a load balancer, so rate limits apply to real client IPs
- [ ] `TRUSTED_WASM_HASHES` set to the audited contract build hash(es)
- [ ] `METRICS_TOKEN` set, or `/metrics` blocked at the edge
- [ ] `DATABASE_SSL=true` for managed Postgres
- [ ] A dedicated or paid Soroban RPC endpoint (public endpoints are rate-limited)

## Probes and monitoring

- **Liveness:** `GET /health`. Only checks the process.
- **Readiness:** `GET /health/ready`. Returns `503` if the database is down. Returns `degraded`
  with HTTP 200 when RPC is unreachable or indexer lag exceeds `INDEXER_MAX_LAG_LEDGERS`, so a
  slow RPC doesn't take the API out of rotation.

Prometheus metrics (prefix `stellarsafe_`):

| Metric                                   | Alert suggestion                          |
| ---------------------------------------- | ----------------------------------------- |
| `indexer_lag_ledgers`                    | > 120 for 5 min (about 10 min behind)     |
| `indexer_errors_total`                   | rate > 0 for 10 min                       |
| `indexer_events_total{result="invalid"}` | any increase: a contract/decoder mismatch |
| `notification_deliveries_total{result}`  | dead/failure ratio                        |
| `http_request_duration_seconds`          | p95 latency, 5xx rate                     |

## Runbooks

**Indexer is lagging.** Check `indexer_errors_total` and the worker logs. Common causes are RPC
rate limiting (use a better RPC) or the window being too large (lower `INDEXER_WINDOW_LEDGERS`).
The indexer resumes from its checkpoints, so a restart is always safe.

**`historyComplete: false` on a treasury.** The treasury was registered, or the worker was down,
for longer than RPC retention (about 7 days on public nodes). Events from the gap are missing from
the read model. The contract state itself is unaffected. To recover, use an archival RPC: set
`last_indexed_ledger = <deploy ledger> - 1` and `history_complete = true`, then let the worker
backfill.

**Invalid events (`decode_error` set).** The contract emitted something the decoder rejects. Fix
the decoder (see [EVENTS.md](EVENTS.md)), deploy, then run
`DATABASE_URL=… node dist/cli/reproject.js <contractId>`, or `--all`. Reprojection runs in one
transaction and sends no notifications.

**Rotating `JWT_SECRET`.** Every access token becomes invalid immediately. Clients refresh
(refresh tokens are stored hashed and still work) or sign in again.

**Rotating `SECRETS_ENCRYPTION_KEY`.** No dual-key support yet. Subscribers must call
`rotate-secret` after the change. Planned work: see CONTRIBUTING.

## Data retention

The worker prunes once an hour:

- auth challenges more than 1 day past expiry
- refresh tokens more than 7 days past expiry
- outbox rows (and their deliveries) 30 days after fan-out
- test pings after 30 days

`chain_events` and `activity` are kept forever. They are the audit trail.

## Backups

Back up Postgres regularly. The read model can be rebuilt from `chain_events`. Off-chain data
can't be rebuilt from the chain: names, proposal metadata, subscriptions and API audit entries.
