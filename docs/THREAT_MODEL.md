# Threat model

Scope: `stellarsafe-api`. The contracts are out of scope here; they have their own threat model.

## Assets

1. **Funds.** These are held by contracts. The API has no signing authority, so it can't lose them directly.
2. **Integrity of what users see** before they sign (policy, proposal details, approvals).
3. **Sessions** (access and refresh tokens).
4. **Webhook secrets** and the subscriber endpoints.
5. **Availability** of the indexer and the API.

## Threats and mitigations

| #   | Threat                                                                 | Mitigation                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Compromised or buggy API shows false proposal data to trick a signer   | The API can't sign. Clients must simulate and inspect the transaction they sign (SDK). Metadata is bound to the on-chain hash. Responses carry ledger/tx references for checking.                                                                                          |
| T2  | Attacker registers a look-alike contract that emits StellarSafe events | `TRUSTED_WASM_HASHES` allowlist. Events are only read from the registered contract ID. SAC tokens are rejected.                                                                                                                                                            |
| T3  | Sign-in replay or phishing                                             | Challenges are single-use (atomic consume), short-lived, and bound to the domain and network in the signed text. SEP-10 checks the exact issued transaction hash and server signature.                                                                                     |
| T4  | Stolen refresh token                                                   | Rotation on every use. Reusing a rotated token revokes the whole session family. Only SHA-256 hashes are stored.                                                                                                                                                           |
| T5  | Stolen access token                                                    | 15-minute lifetime by default, HS256 with a ≥32-character secret, issuer and audience checks.                                                                                                                                                                              |
| T6  | SSRF via webhook URLs (cloud metadata, internal services)              | HTTPS only in production. Credentials in URLs rejected. IP literals and `localhost`/`.internal` rejected. **Every resolved IP is checked at connect time** (defeats DNS rebinding). No redirects. Timeouts. Response size capped.                                          |
| T7  | Webhook spoofing to subscribers                                        | HMAC-SHA256 signatures with a timestamp (`t=…,v1=…`). Per-subscription secrets, AES-256-GCM encrypted at rest, shown only once, rotatable.                                                                                                                                 |
| T8  | Spamming third parties via webhooks                                    | Only current members of a treasury receive its events. 20 subscriptions per account. Test pings are rate-limited. Endpoints are auto-disabled on failure or `410`.                                                                                                         |
| T9  | Unauthorized off-chain edits                                           | Writes need a JWT and current indexed membership. Every edit is recorded in the audit trail with the actor.                                                                                                                                                                |
| T10 | Duplicate or missed events (crashes, two indexers)                     | Compare-and-set checkpoints, idempotent inserts, an advisory lock, and the raw event log for reprojection.                                                                                                                                                                 |
| T11 | Malformed or malicious event payloads                                  | Strict zod validation per event, bounded array sizes, positive amounts. Invalid events are stored, flagged and never projected.                                                                                                                                            |
| T12 | CSV formula injection in audit exports                                 | Cells starting with `= + - @ \t \r` are prefixed with `'` and quoted.                                                                                                                                                                                                      |
| T13 | DoS / brute force                                                      | Global and per-route rate limits (stricter on auth), 64 KB body limit, 30 s statement timeout, bounded pagination (≤100).                                                                                                                                                  |
| T14 | Accidental mainnet use with unaudited contracts                        | Startup refuses `STELLAR_NETWORK=mainnet` unless `ALLOW_MAINNET=true`.                                                                                                                                                                                                     |
| T15 | Secrets leaking into logs                                              | pino redaction of auth headers, tokens, signatures and secrets.                                                                                                                                                                                                            |
| T16 | Email bombing via free throwaway accounts                              | Double opt-in. At most 3 confirmation emails per _address_ per day across all accounts, serialised with an advisory lock. Link endpoints act only on POST, so mail scanners can't confirm or unsubscribe by prefetching. One-click unsubscribe tokens are MACs (RFC 8058). |
| T17 | Indexer flooding by registering junk contracts                         | 20 registrations per account per day, `RATE_LIMIT_WRITE_MAX` per IP per minute, a startup warning in production when `TRUSTED_WASM_HASHES` is empty, SAC rejection.                                                                                                        |
| T18 | RPC quota drain via balance reads                                      | 15-second cache per token/treasury that also merges concurrent reads, plus a per-route rate limit.                                                                                                                                                                         |
| T19 | RPC amplification via the public readiness probe                       | The ledger tip is cached for 5 seconds, so any number of probe hits make at most one RPC call per 5 seconds.                                                                                                                                                               |
| T20 | HTML injection in email confirmation pages                             | Tokens are HTML-escaped before rendering, and pages are served under `default-src 'none'`.                                                                                                                                                                                 |

## Residual risks and known limitations

- **Indexed data lags the chain.** It can be `INDEXER_MAX_LAG_LEDGERS` behind, or more during an
  RPC outage. `/health/ready` reports `degraded` when that happens.
- **Rate limiting fails open.** With `REDIS_URL` set, limits are shared across replicas. Without
  it, each process counts separately. If Redis goes down, requests are still served (no limits)
  and readiness reports `degraded`. That trade-off keeps the API available.
- **This review was done by the author, not independently.** It was an adversarial pass over the
  code (T16–T20 came out of it), but it doesn't replace an external audit before mainnet.
- **SEP-10 checks the account's master key only.** Accounts whose master weight is 0 and that
  rely on other signers can't sign in.
- **A trusted RPC provider is assumed.** A malicious RPC could feed the indexer false events.
  Run your own RPC or use a reputable provider. The client-side checks in T1 still apply.
- **A compromised database** could alter off-chain metadata and the read model. On-chain
  verification (T1) limits the impact to display data.
