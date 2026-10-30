# Architecture

```
                 ┌──────────────────────────── Stellar network ───────────────────────────┐
                 │  StellarSafe treasury contracts (source of truth for funds & policy)   │
                 └───────────────▲──────────────────────────────────┬─────────────────────┘
       signs & submits txs       │                                  │ getEvents / getLedgerEntries /
       (wallet, never the API)   │                                  │ simulateTransaction (read-only)
┌────────────────┐               │                    ┌─────────────▼──────────────┐
│ stellarsafe-web│───────────────┘                    │        Soroban RPC          │
│ / SDK clients  │                                    └─────────────▲──────────────┘
└───────┬────────┘                                                  │
        │ HTTPS (JWT)                                               │
┌───────▼──────────────────────────┐            ┌───────────────────┴─────────────────┐
│ API process (src/server.ts)      │            │ Worker process (src/worker.ts)       │
│  auth · treasuries · proposals   │            │  Indexer ─► projector ─► outbox      │
│  activity · notifications · docs │            │  Notification dispatcher ─► webhooks │
└───────┬──────────────────────────┘            └───────────────────┬─────────────────┘
        └──────────────────────► PostgreSQL ◄───────────────────────┘
```

## Trust model

The API is a **coordination layer**. It has no keys that control funds and cannot approve, sign,
execute or block payments. Its data can be stale or, if the server is compromised, wrong. So:

- Clients must read authoritative state (policy, approvals, balances) from the chain before signing.
  The SDK does this.
- Indexed responses include ledger numbers (`indexing.lastIndexedLedger`, `ledger`, `txHash`) so
  clients can check them against the chain.
- Off-chain writes (display names, proposal descriptions, subscriptions) are authorized against
  **indexed on-chain membership**. They never affect funds.
- Proposal descriptions are content-addressed and committed on-chain (see [EVENTS.md](EVENTS.md)).

## Modules

| Module        | Path                        | Responsibility                                                                     |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| Auth          | `src/modules/auth`          | SEP-53 / SEP-10 challenges, JWT access tokens, rotating refresh tokens             |
| Registry      | `src/modules/treasuries`    | Register contracts (existence + WASM allowlist), members, allowlist, live balances |
| Proposals     | `src/modules/proposals`     | Proposal queries, computed status, content-addressed metadata                      |
| Activity      | `src/modules/activity`      | Unified audit trail (chain + API), filters, CSV export                             |
| Notifications | `src/modules/notifications` | Webhook subscriptions, SSRF guard, signing, dispatcher                             |
| Indexer       | `src/indexer`               | Event fetch, decode, projection, reprojection                                      |
| Chain         | `src/chain`                 | The only code that talks to RPC (`ChainClient` interface)                          |

## Indexer design

1. **Per-treasury checkpoints.** Each treasury stores `last_indexed_ledger`. Treasuries with the
   same checkpoint are fetched together (25 contracts per RPC request, 5 filters × 5 IDs). A
   newly registered treasury backfills in its own group without holding up the others, then merges in.
2. **Bounded windows.** Each step scans `[checkpoint+1, min(checkpoint+INDEXER_WINDOW_LEDGERS, tip)]`.
   It starts in ledger-range mode and continues with cursors. Events past the window are dropped,
   because RPC cursor pages aren't bounded by `endLedger`.
3. **Atomic apply.** In one transaction: take an advisory lock, advance the checkpoint with
   compare-and-set (`WHERE last_indexed_ledger = expected`), insert raw events
   (`ON CONFLICT DO NOTHING`), then update projections, the activity feed and the notification
   outbox. A crash or a second replica can't skip events or apply them twice.
4. **No reorgs.** Stellar consensus is final, so the indexer never rolls anything back.
5. **Retention gaps.** RPC keeps about 7 days of history. If a treasury's checkpoint is older than
   that, the indexer jumps ahead and sets `historyComplete: false`.
6. **Bad events.** Every event is stored raw (XDR). Undecodable events are kept with
   `decode_error` and skipped. After fixing the decoder, rebuild with `npm run reproject -- <id>`.
   That rebuilds projections from the raw log and sends no notifications.

## Notifications

This is a transactional outbox. The projector writes `notification_outbox` rows in the same
transaction as the state change. The dispatcher then:

1. **Fans out** each outbox row to matching, enabled subscriptions. The subscriber must be a
   current member and must have subscribed before the event.
2. **Delivers** with at-least-once semantics. Rows are claimed with `FOR UPDATE SKIP LOCKED`
   plus a lease, so concurrent workers are safe and a crashed worker's rows get picked up again.
   Retries use exponential backoff with jitter and honour `Retry-After`. Deliveries are
   dead-lettered after `NOTIFY_MAX_ATTEMPTS`. A subscription is auto-disabled after repeated
   failures, or immediately on `410 Gone`.

Receivers should de-duplicate on the `X-StellarSafe-Delivery` header. See [WEBHOOKS.md](WEBHOOKS.md).

## Data model

See [`src/db/migrations/0001_initial.ts`](../src/db/migrations/0001_initial.ts). Tables fall into
three groups:

- **Auth**: `auth_challenges`, `refresh_tokens`
- **Read model** (rebuildable from `chain_events`): `treasuries`, `treasury_members`,
  `treasury_recipients`, `proposals`, `proposal_approvals`, chain rows in `activity`
- **Off-chain state** (not rebuildable): treasury names and descriptions, `proposal_metadata`,
  API rows in `activity`, and the notification tables
