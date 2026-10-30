---
title: 'feat(activity): stream the CSV export instead of capping at 10,000 rows'
labels: [contributor-task, api, medium]
---

## Goal

Large treasuries can export their full audit trail without the 10,000-row limit or loading everything into memory.

## Acceptance criteria

- [ ] The export streams rows in pages using keyset pagination
- [ ] Memory use stays flat for 100k+ rows
- [ ] CSV escaping is unchanged (and guards against formula injection: `=`, `+`, `-`, `@`)
- [ ] Integration test exporting more than one page of rows
- [ ] `openapi.json` summary updated

## Pointers

- `src/modules/activity/service.ts` → `exportCsv`, `src/modules/activity/routes.ts`
