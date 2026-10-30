---
title: 'feat(auth): revoke access tokens immediately on logout'
labels: [contributor-task, auth, hard]
---

## Goal

After logout or refresh-token reuse detection, the access tokens of that session stop working right away instead of staying valid until they expire.

## Acceptance criteria

- [ ] Access tokens carry the session family id (e.g. a `sid` claim)
- [ ] Revoked families are checked on each authenticated request, using Redis when configured and a cached DB lookup otherwise
- [ ] Revocation entries expire after `ACCESS_TOKEN_TTL_SECONDS`
- [ ] Integration tests: logout → old access token gets 401; refresh-token reuse → access token gets 401
- [ ] Note the latency cost in `docs/PERFORMANCE.md`

## Pointers

- `src/modules/auth/service.ts` (`issueTokens`, `revokeFamily`, `verifyAccessToken`)
- `src/plugins/auth.ts`
