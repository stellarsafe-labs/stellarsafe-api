---
title: 'feat(api): GET /treasuries/:id/spending with per-department, per-period totals'
labels: [contributor-task, api, medium]
---

## Goal

Treasury members can see how much was spent, grouped by department and by period (day/week/month), computed from executed proposals.

## Acceptance criteria

- [ ] `GET /treasuries/:id/spending?period=month&from=&to=&token=` returns totals per department and period
- [ ] Amounts stay as decimal strings (i128-safe, no floats)
- [ ] Only `executed` proposals count
- [ ] Integration tests cover grouping, date filters, multiple tokens and an empty treasury
- [ ] `openapi.json` regenerated

## Pointers

- `src/modules/proposals/service.ts`, `src/modules/treasuries/routes.ts`
- `src/db/schema.ts` → `proposals` table (`department`, `amount`, `executed_at`)
- Consider an index in a new migration if the query is slow (see `docs/PERFORMANCE.md`)
