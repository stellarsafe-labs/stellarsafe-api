---
title: 'test(notifications): unit tests for summarize() covering every event type'
labels: [contributor-task, tests, good first issue]
---

## Goal

Every chat summary (Slack/Discord) is covered by a test, so wording changes and missing fields are caught.

## Acceptance criteria

- [ ] One test per event type in `summarize()`, plus the default case
- [ ] Tests for missing `data` fields (no crash, readable output)
- [ ] Test that long addresses are shortened (`GABC…WXYZ`)
- [ ] Test that the Discord body disables mentions (`allowed_mentions`)

## Pointers

- `src/modules/notifications/formats.ts`
- `test/unit/misc.test.ts` for style
