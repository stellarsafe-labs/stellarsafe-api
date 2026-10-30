---
title: 'refactor(notifications): await the running tick in dispatcher stop() instead of polling'
labels: [contributor-task, notifications, good first issue]
---

## Goal

Shutdown waits for the in-progress dispatcher tick directly, instead of checking a flag every 25 ms.

## Acceptance criteria

- [ ] `loop()` stores its promise; `stop()` awaits it
- [ ] Behaviour is unchanged: no new ticks start after `stop()`, and in-flight deliveries finish
- [ ] Apply the same pattern to the indexer if it uses the same loop
- [ ] Existing tests pass; add one that calls `stop()` during a slow delivery

## Pointers

- `src/modules/notifications/dispatcher.ts` → `stop()`, `loop()`
- `src/indexer/indexer.ts`
