---
title: 'feat(ops): OpenTelemetry tracing for HTTP, DB and RPC calls'
labels: [contributor-task, ops, hard]
---

## Goal

Operators can trace a request end-to-end (HTTP → Postgres → Soroban RPC) in any OTLP backend.

## Acceptance criteria

- [ ] Tracing is off by default and enabled with `OTEL_EXPORTER_OTLP_ENDPOINT`
- [ ] Spans for Fastify requests, Kysely/pg queries and chain-client RPC calls
- [ ] Trace id is added to pino log lines
- [ ] No noticeable overhead when disabled (check with `bench/`)
- [ ] `docs/OPERATIONS.md` explains setup with a local Jaeger example

## Pointers

- `src/server.ts`, `src/worker.ts`, `src/lib/logger.ts`, `src/chain/chain-client.ts`
