# Security Policy

drep.tools is a coordination platform for Cardano DReps and delegators. It is
non-custodial: it never receives, requests, or stores private keys, and write
access is gated by wallet signatures and on-chain role proofs. We take
security reports seriously and appreciate responsible disclosure.

## Supported versions

drep.tools is a continuously deployed AWS-hosted SPA + Lambda backend; there
are no released versions to track. The live site at
[drep.tools](https://drep.tools) and the API at
[api.drep.tools](https://api.drep.tools) always run the latest code from
`main`. Please report issues against the current `main` branch and the live
site.

## Reporting a vulnerability

Please report security issues privately, not in a public GitHub issue, so
they can be fixed before they are widely known.

- Email: [claude@rusch.me](mailto:claude@rusch.me).
- Alternative: open a private advisory through GitHub's
  [Report a vulnerability](https://github.com/adamrusch/drep-platform/security/advisories/new)
  feature for this repository.

When reporting, please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected URL or code path, and the network (mainnet or preprod).
- Any relevant logs, requests, or screenshots.

Please give us a reasonable chance to fix the issue before disclosing it
publicly.

## Scope

In scope:

- The web application ([drep.tools](https://drep.tools)) and the API
  ([api.drep.tools](https://api.drep.tools)) and their CIP-30 / on-chain auth
  flows.
- The wallet-signature authentication, JWT issuance and revocation, and
  on-chain role gating (DRep, SPO, Constitutional Committee, proposer). See
  [`docs/SECURITY_REVIEW_IDENTITY.md`](docs/SECURITY_REVIEW_IDENTITY.md) for
  the engineering review of the identity subsystem.
- The committee mutation signing protocol
  ([`shared/committeeMessages.ts`](shared/committeeMessages.ts)) — every
  drep.tools committee mutation is authorised by a fresh CIP-30 signature
  over a canonical plaintext.
- The Sybil-defense pipeline for comment-vote stake re-weighting and
  clubhouse delegation gating
  (`backend/src/sync/revalidate-comment-stake.ts`).
- The governance / DRep directory / pool-metadata / CC-members sync workers
  and their writes to DynamoDB.
- The CIP-1694 on-chain vote submission path (frontend tx assembly + backend
  receipt recording).

Out of scope:

- Vulnerabilities in third-party services we depend on (AWS, Koios,
  Blockfrost, wallet software, MeshSDK). Report those to the respective
  vendor.
- Issues that require a compromised wallet, device, or browser extension.
- Denial of service through sheer request volume, and findings from
  automated scanners without a demonstrated realistic impact.

## What to expect

- We will acknowledge your report as soon as we reasonably can.
- We will keep you informed as we investigate and work on a fix.
- We will credit you for the find if you would like, once the issue is
  resolved.

Thank you for helping keep drep.tools and its users safe.
