---
title: 'feat(notifications): "proposal expiring soon" reminders'
labels: [contributor-task, notifications, medium]
---

## Goal

Members get a reminder before a pending proposal expires, so it doesn't lapse unnoticed.

## Acceptance criteria

- [ ] A scheduled job in the worker finds pending proposals expiring within a configurable window (e.g. `PROPOSAL_EXPIRY_REMINDER_HOURS`, default 24)
- [ ] It writes one `proposal.expiring` outbox row per proposal, de-duplicated so restarts never send twice
- [ ] Slack/Discord/email summaries handle the new event type
- [ ] Integration tests cover: reminder sent once, no reminder for executed/cancelled proposals, no reminder outside the window
- [ ] `docs/WEBHOOKS.md` documents the new event
- [ ] `openapi.json` regenerated (if the API changed)

## Pointers

- `src/workers.ts` (maintenance loop), `src/modules/notifications/dispatcher.ts` (outbox fan-out)
- `src/modules/notifications/formats.ts` → `summarize()`
- A new migration may be needed to track sent reminders (see CONTRIBUTING rule 3)
