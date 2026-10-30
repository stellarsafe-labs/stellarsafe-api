---
title: 'test(indexer): property-based tests for the event decoder with fast-check'
labels: [contributor-task, tests, medium]
---

## Goal

The decoder never crashes on malformed or unexpected Soroban events. It either decodes them or rejects them cleanly.

## Acceptance criteria

- [ ] Add `fast-check` as a dev dependency
- [ ] Property: random `ScVal` topics/bodies never throw an unhandled error
- [ ] Property: events built by `EventFactory` always round-trip to the expected decoded shape
- [ ] Tests run in under 5 seconds in CI

## Pointers

- `src/indexer/decoder.ts`, `test/unit/decoder.test.ts`, `test/helpers/events.ts`
