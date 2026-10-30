---
title: 'feat(auth): list and revoke active sessions'
labels: [contributor-task, auth, medium]
---

## Goal

Users can see where they are signed in (IP, user agent, last used) and sign out a single session.

## Acceptance criteria

- [ ] `GET /auth/sessions` lists active refresh-token families for the current account
- [ ] `DELETE /auth/sessions/:id` revokes one family; users can't revoke other accounts' sessions
- [ ] The current session is marked in the list
- [ ] Integration tests for listing, revoking and cross-account access
- [ ] `openapi.json` regenerated

## Pointers

- `src/modules/auth/service.ts` (`refresh_tokens` already stores `ip`, `user_agent`, `family_id`)
- `src/modules/auth/routes.ts`
