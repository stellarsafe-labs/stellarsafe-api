# Contract event schema (v1)

This is the interface between **stellarsafe-contracts** and the indexer in this repo. The contracts
must emit these events. The decoder lives in [`src/indexer/decoder.ts`](../src/indexer/decoder.ts)
and is covered by `test/unit/decoder.test.ts`.

## Shape

Every event uses:

- `topics[0]`: a `Symbol` naming the event (table below). You can add more topics (for example the
  proposal id, so RPC can filter on it). The indexer ignores them.
- **body**: a `Map<Symbol, Val>`, which is what a `#[contracttype]` struct serialises to. Unknown
  fields are ignored, so you can add fields without breaking the indexer.

```rust
// Example (soroban-sdk)
env.events().publish(
    (symbol_short!("approved"), id),
    ApprovedEvent { id, approver, approvals },
);
```

Optional fields are `Option<T>`; `None` (`Void`) decodes to `null`.

## Events

| `topics[0]` | Body fields                                                                                                                                                                                                                                                      | API type                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `init`      | `admin: Option<Address>`, `members: Vec<Address>` (G-accounts, ≤100), `policy: Policy`                                                                                                                                                                           | `treasury.initialized`      |
| `mem_add`   | `member: Address`, `role: Option<Symbol>` (default `member`)                                                                                                                                                                                                     | `member.added`              |
| `mem_rm`    | `member: Address`                                                                                                                                                                                                                                                | `member.removed`            |
| `policy`    | `policy: Policy`                                                                                                                                                                                                                                                 | `policy.updated`            |
| `allow_add` | `recipient: Address`, `label: Option<String>`                                                                                                                                                                                                                    | `recipient.added`           |
| `allow_rm`  | `recipient: Address`                                                                                                                                                                                                                                             | `recipient.removed`         |
| `proposed`  | `id: u64`, `proposer: Address`, `recipient: Address`, `token: Address`, `amount: i128` (> 0), `expires_at: u64` (unix seconds, ledger time), `policy_version: u32`, `required_approvals: u32`, `department: Option<Symbol>`, `metadata_hash: Option<BytesN<32>>` | `proposal.created`          |
| `approved`  | `id: u64`, `approver: Address`, `approvals: u32` (count after this approval)                                                                                                                                                                                     | `proposal.approved`         |
| `revoked`   | `id: u64`, `approver: Address`, `approvals: u32` (count after revocation)                                                                                                                                                                                        | `proposal.approval_revoked` |
| `executed`  | `id: u64`, `executor: Address`, `period_spent: Option<i128>`                                                                                                                                                                                                     | `proposal.executed`         |
| `cancelled` | `id: u64`, `by: Address`                                                                                                                                                                                                                                         | `proposal.cancelled`        |

`Policy` is a struct that must contain at least `version: u32` and `threshold: u32`. All other fields
(for example `high_value_amount`, `high_value_threshold`, `allowlist_enabled`, `period_seconds`,
`department_limits`) are stored as-is and returned by `GET /treasuries/:id` → `policy`. `u64`/`i128`
values become decimal strings and `Bytes` become hex.

## Semantics the indexer relies on

- **Policy versions only go up.** If the indexer sees an older version, it does not overwrite a newer one.
- **`approvals` is authoritative.** The indexer copies the contract's count. It never counts approvals itself.
- **Approvals made under an old policy version** are reported as `policyOutdated: true`. The
  contract must refuse to execute such proposals.
- **Expiry** uses ledger time. The API reports `status: "expired"` for pending proposals whose
  `expires_at` has passed.
- Events in the same ledger are applied in RPC event-id order, which is the order the chain executed them.

## Proposal metadata hash

Descriptions live off-chain. The proposal commits to them on-chain through `metadata_hash`:

```
metadata_hash = sha256( UTF-8( JSON with keys sorted, no whitespace, absent fields omitted ) )
keys: category?, description, externalUrl?, title
```

Example: `{"description":"March","title":"Payroll"}`.

Flow: `POST /treasuries/:id/proposal-metadata` returns `metadataHash`. Pass it to
`propose_payment(..., metadata_hash)`. The API attaches the metadata only to a proposal whose
on-chain hash matches, so a description can't be swapped afterwards.

## Versioning

Breaking changes to this schema need a new event name (for example `proposed2`) or a `v` topic.
Old treasuries keep emitting v1 events, so the decoder has to keep supporting them.
