---
title: 'feat(notifications): endpoint to retry a dead-lettered delivery'
labels: [contributor-task, notifications, medium]
---

## Goal

After fixing a broken webhook, a user can re-send deliveries that were dead-lettered.

## Acceptance criteria

- [ ] `POST /notifications/deliveries/:id/retry` sets the delivery back to `pending` and resets its attempts
- [ ] Only the subscription owner can retry; other users get a 404
- [ ] Only `dead` deliveries can be retried; others return 409
- [ ] Rate limited like other write endpoints
- [ ] Integration tests for success, wrong owner and wrong status
- [ ] `openapi.json` regenerated

## Pointers

- `src/modules/notifications/routes.ts` (`/deliveries`), `src/modules/notifications/service.ts`
