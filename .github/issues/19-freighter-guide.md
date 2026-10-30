---
title: 'docs: end-to-end "Sign in with Freighter" guide'
labels: [contributor-task, docs, good first issue]
---

## Goal

Frontend developers can add StellarSafe sign-in to their app by following one guide.

## Acceptance criteria

- [ ] New `docs/AUTH.md` with the full flow: `/auth/challenge` → Freighter `signMessage` → `/auth/verify` → refresh → logout
- [ ] Working TypeScript snippet using `@stellar/freighter-api`
- [ ] Explains the SEP-10 (transaction) mode for hardware wallets
- [ ] Lists common errors (expired challenge, wrong network) and how to fix them
- [ ] Linked from README

## Pointers

- `src/modules/auth/routes.ts`, `src/modules/auth/service.ts` → `buildMessage()`
- `test/integration/auth.test.ts` shows the flow in code
