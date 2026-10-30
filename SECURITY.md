# Security policy

StellarSafe is pre-audit software. **Use Stellar testnet only.**

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's **"Report a vulnerability"** button (Security
tab → Advisories). Please include:

- the affected component and version or commit
- reproduction steps or a proof of concept
- the impact you expect

We aim to acknowledge reports within 3 business days and to agree on a disclosure timeline with
you. Please don't publicly disclose an issue until a fix is released.

## Scope

Most relevant to this repo: authentication bypass, authorization flaws in off-chain writes,
SSRF through webhooks, indexer integrity (events skipped, duplicated or spoofed), secret exposure,
and injection. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the threats we've considered.
