---
title: 'test: unit tests for delivery backoff and cursor pagination'
labels: [contributor-task, tests, good first issue]
---

## Goal

The retry schedule and pagination cursors are covered by fast unit tests that need no database.

## Acceptance criteria

- [ ] `backoffMs()`: values for attempts 1–8, jitter bounds (±20%), 6h cap, using an injected `random`
- [ ] Cursor encode/decode round-trips, and invalid or tampered cursors return a 400 error
- [ ] `paginate()` returns `nextCursor` only when there are more rows

## Pointers

- `src/modules/notifications/dispatcher.ts` → `backoffMs`
- `src/lib/pagination.ts`
