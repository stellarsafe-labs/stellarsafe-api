---
title: 'chore(dev): add Mailpit to docker-compose for local email testing'
labels: [contributor-task, ops, good first issue]
---

## Goal

Contributors can test the email channel locally and see sent emails in a web inbox.

## Acceptance criteria

- [ ] `mailpit` service in `docker-compose.yml` (SMTP on 1025, UI on 8025)
- [ ] `.env.example` has commented SMTP settings pointing at Mailpit
- [ ] README "Quick start" explains how to open the inbox
- [ ] Verification and unsubscribe emails render correctly in Mailpit (add a screenshot to the PR)

## Pointers

- `docker-compose.yml`, `.env.example`, `src/modules/notifications/mailer.ts`
