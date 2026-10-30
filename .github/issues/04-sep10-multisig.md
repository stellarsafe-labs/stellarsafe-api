---
title: 'feat(auth): SEP-10 multisig thresholds (load account signers from Horizon)'
labels: [contributor-task, auth, hard]
---

## Goal

Accounts protected by multisig can sign in with SEP-10 when their signatures meet the account's medium threshold, instead of requiring the master key.

## Acceptance criteria

- [ ] Account signers and thresholds are loaded from Horizon (configurable `HORIZON_URL`)
- [ ] Verification uses `WebAuth.verifyChallengeTxThreshold`
- [ ] Accounts that don't exist on-chain fall back to master-key verification (SEP-10 spec)
- [ ] Unit tests with a mocked Horizon response: threshold met, not met, unknown signer
- [ ] `docs/THREAT_MODEL.md` updated

## Pointers

- `src/modules/auth/signatures.ts` → `verifySep10()`
- `src/chain/chain-client.ts` is the only place that should talk to Stellar
