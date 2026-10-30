# stellarsafe-api

Backend services for **StellarSafe**, an open-source treasury and policy engine for Soroban.

The smart contracts enforce the money rules. This API handles everything that doesn't need to
live on-chain: wallet sign-in, indexed treasury state, proposal descriptions, an audit trail, and
notifications.

> **The API can't move funds.** It holds no treasury keys and never signs, approves or executes
> payments. On-chain policy and wallet signatures stay authoritative. Treat indexed data as a
> convenient, possibly delayed view of the chain. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
>
> ⚠️ The contracts are unaudited. Use **testnet** only. The server refuses to start on mainnet
> unless `ALLOW_MAINNET=true`.

## Features

- **Wallet sign-in.** SEP-53 signed messages (Freighter `signMessage`) or SEP-10 challenge
  transactions (hardware wallets). Challenges are single-use and short-lived. Sessions use
  short-lived JWTs plus rotating refresh tokens, and reusing an old refresh token revokes the session.
- **Soroban event indexer.** Per-treasury checkpoints, bounded ledger windows, atomic
  compare-and-set commits, backfill for newly registered treasuries, detection of gaps in RPC
  history, a raw event log, and a `reproject` tool to rebuild data.
- **Treasury registry.** Checks that a contract exists on-chain and, optionally, that its WASM hash
  is on an allowlist. Serves members, the recipient allowlist, policy, and live balances.
- **Proposals.** Status is computed (pending / expired / executed / cancelled). Each proposal
  carries approvals, a `policyOutdated` flag, and **content-addressed metadata committed on-chain**.
- **Audit API.** One timeline of on-chain events and off-chain actions, with filters, cursor
  pagination and CSV export.
- **Notifications.** Signed webhooks (JSON, Slack or Discord format) with SSRF protection, and
  email with double opt-in and one-click unsubscribe. Both get retries, dead-lettering,
  auto-disable and a delivery log.
- **Operations.** OpenAPI 3.1 docs at `/docs`, liveness and readiness probes, Prometheus
  `/metrics`, structured logs with redaction, rate limiting (shared through Redis across
  replicas), security headers, graceful shutdown, and a Docker image that runs as non-root.
  Load-tested: see [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Quick start

```bash
cp .env.example .env            # defaults target Stellar testnet
docker compose up --build       # postgres + migrations + api (:3000) + worker
open http://localhost:3000/docs
```

Without Docker (needs Node 22+ and Postgres 14+):

```bash
npm ci
cp .env.example .env            # point DATABASE_URL at your Postgres
npm run migrate
npm run dev                     # API with reload
npm run dev:worker              # indexer + notifications (separate terminal)
```

## Sign-in flow

```ts
// 1. Ask for a challenge
const ch = await post('/auth/challenge', { account: publicKey }); // mode: "message" (default)
// 2. Sign it in the wallet (SEP-53)
const { signedMessage } = await freighter.signMessage(ch.message, { address: publicKey });
// 3. Exchange it for tokens
const { accessToken, refreshToken } = await post('/auth/verify', {
  challengeId: ch.challengeId,
  signature: signedMessage,
});
```

For SEP-10, call `POST /auth/challenge { account, mode: "transaction" }`, sign `transaction` with
`signTransaction`, then send `{ challengeId, signedTransaction }`. This needs `SEP10_SIGNING_SECRET`.

## API overview

| Method & path                                          | Auth | Description                                    |
| ------------------------------------------------------ | ---- | ---------------------------------------------- |
| `POST /auth/challenge` · `/auth/verify`                |      | Wallet sign-in                                 |
| `POST /auth/refresh` · `/auth/logout` · `GET /auth/me` |      | Sessions                                       |
| `GET /treasuries?member=G…`                            |      | List indexed treasuries                        |
| `POST /treasuries`                                     | ✓    | Register a deployed treasury contract          |
| `GET /treasuries/:id` · `PATCH`                        | (✓)  | Details · edit display metadata (members)      |
| `GET /treasuries/:id/members` · `/recipients`          |      | Indexed membership and allowlist               |
| `GET /treasuries/:id/balances`                         |      | Live token balances read from chain            |
| `GET /treasuries/:id/proposals[/:proposalId]`          |      | Proposals with approvals and verified metadata |
| `POST /treasuries/:id/proposal-metadata`               | ✓    | Store a description and get its hash           |
| `GET /treasuries/:id/activity[/export]`                |      | Audit trail (JSON / CSV)                       |
| `GET/POST/PATCH/DELETE /notifications/preferences`     | ✓    | Webhook subscriptions                          |
| `GET /notifications/deliveries`                        | ✓    | Delivery log                                   |
| `GET /health` · `/health/ready` · `/metrics`           |      | Probes and metrics                             |

The full spec is served at `/docs` and committed as [`openapi.json`](openapi.json) for SDK
generation. CI fails if the committed file is out of date.

Errors always look like `{ "error": { "code", "message", "details?", "requestId" } }`. List
endpoints return `{ items, nextCursor }`.

## Development

```bash
npm test               # unit + integration (starts Postgres in Docker via Testcontainers)
npm run test:coverage
npm run check          # typecheck + lint + format + tests
npm run openapi        # regenerate openapi.json
```

Integration tests use a real Postgres and a fake chain (`test/helpers/fake-chain.ts`). Set
`TEST_DATABASE_URL` to use an existing server instead of Docker, as CI does.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): modules, indexer design, outbox, data model
- [Contract event schema](docs/EVENTS.md): the interface `stellarsafe-contracts` must emit
- [Notifications](docs/WEBHOOKS.md): webhook payloads, signature verification, retries, email
- [Performance](docs/PERFORMANCE.md): load-test results and how to reproduce them
- [Operations](docs/OPERATIONS.md): deployment, configuration, monitoring, runbooks
- [Threat model](docs/THREAT_MODEL.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

## License

[Apache-2.0](LICENSE)
