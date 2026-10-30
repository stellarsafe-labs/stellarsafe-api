---
title: 'feat(indexer): CLI to reset a treasury checkpoint for archival backfill'
labels: [contributor-task, indexer, medium]
---

## Goal

Operators can rewind a single treasury's indexer checkpoint to a given ledger (for example after connecting to an archival RPC) and re-index from there.

## Acceptance criteria

- [ ] `npm run reset-checkpoint -- <contractId> <ledger>` updates the checkpoint safely
- [ ] Refuses to run without `--yes`, and prints what will change
- [ ] Re-indexing after the reset produces no duplicate events or projections
- [ ] Integration test using `FakeChain`
- [ ] `docs/OPERATIONS.md` documents the command

## Pointers

- `src/indexer/indexer.ts`, `src/indexer/reproject.ts`, `src/cli/reproject.ts`
- `test/helpers/fake-chain.ts`
