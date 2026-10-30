---
title: 'feat(ops): Grafana dashboard and Prometheus alert rules'
labels: [contributor-task, ops, medium]
---

## Goal

Operators get a ready-made dashboard and alerts for the API, indexer and notifications.

## Acceptance criteria

- [ ] `ops/grafana/stellarsafe.json` dashboard: request rate/latency, indexer lag, indexer errors, delivery results
- [ ] `ops/prometheus/alerts.yml`: indexer lag too high, error rate spike, readiness failing
- [ ] Optional `prometheus` + `grafana` services in docker-compose (behind a profile)
- [ ] `docs/OPERATIONS.md` explains how to import them

## Pointers

- `src/lib/metrics.ts` (existing metric names), `docs/OPERATIONS.md`
