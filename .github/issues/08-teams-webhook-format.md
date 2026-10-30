---
title: 'feat(notifications): Microsoft Teams webhook format'
labels: [contributor-task, notifications, good first issue]
---

## Goal

Users can send notifications to a Microsoft Teams channel, just like Slack and Discord.

## Acceptance criteria

- [ ] New `teams` value for `WebhookFormat`, rendering the summary as a Teams-compatible payload
- [ ] New migration extends the `format` CHECK constraint (don't edit `0001_initial.ts`)
- [ ] Route schema accepts `teams`
- [ ] Unit test for the rendered body, integration test creating a `teams` subscription
- [ ] `docs/WEBHOOKS.md` and `openapi.json` updated

## Pointers

- `src/modules/notifications/formats.ts` → `renderBody()`
- `src/db/migrations/0001_initial.ts` (existing constraint), `src/db/migrator.ts`
