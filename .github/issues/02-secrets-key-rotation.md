---
title: 'feat(security): dual-key support for SECRETS_ENCRYPTION_KEY rotation'
labels: [contributor-task, security, medium]
---

## Goal

Operators can rotate the key that encrypts webhook secrets without downtime or losing existing subscriptions.

## Acceptance criteria

- [ ] New optional `SECRETS_ENCRYPTION_KEY_PREVIOUS` config value
- [ ] `SecretBox` encrypts with the current key and decrypts with current, then previous
- [ ] A CLI (`npm run rotate-secrets`) re-encrypts all stored secrets with the current key
- [ ] Unit tests for encrypt/decrypt with both keys and with a wrong key
- [ ] `docs/OPERATIONS.md` describes the rotation procedure step by step

## Pointers

- `src/lib/crypto.ts` (`SecretBox`), `src/config.ts`
- `src/cli/` for existing CLI examples
