---
title: 'docs: document which endpoints are public and why'
labels: [contributor-task, docs, good first issue]
---

## Goal

It is clear to integrators and auditors which endpoints need no sign-in (for example, proposal lists and proposal metadata) and why that is safe.

## Acceptance criteria

- [ ] A table in `docs/THREAT_MODEL.md` listing every endpoint as public or authenticated
- [ ] Short reasoning for each public endpoint (e.g. data is already public on-chain)
- [ ] Note that proposal metadata is off-chain but readable by anyone who knows its hash
- [ ] README links to the table

## Pointers

- `src/modules/*/routes.ts` (look for `onRequest: [app.authenticate]`)
- `openapi.json` → `security` fields
