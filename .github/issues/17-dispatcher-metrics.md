---
title: 'feat(ops): Prometheus gauges for notification backlog and dead letters'
labels: [contributor-task, ops, good first issue]
---

## Goal

Operators can alert when notifications pile up or start failing.

## Acceptance criteria

- [ ] Gauge `stellarsafe_notification_pending` (pending deliveries that are due)
- [ ] Gauge `stellarsafe_notification_outbox_unfanned` (outbox rows not yet fanned out)
- [ ] Gauge `stellarsafe_notification_dead_total` (dead-lettered in the last 24h)
- [ ] Values refresh on a timer, not on every scrape
- [ ] Documented in `docs/OPERATIONS.md`

## Pointers

- `src/lib/metrics.ts`, `src/workers.ts`
