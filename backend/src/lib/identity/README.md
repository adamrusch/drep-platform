# `identity/` — adopted authentication & identity subsystem

This module is a **cohesive port of DRep Talk's `src/lib/auth/*`, `src/lib/crypto/*`,
and `src/lib/cardano/identity.ts`** (https://github.com/katomm/dreptalk.com, Apache-2.0),
adapted to the drep-platform stack. It is kept as a self-contained subsystem on purpose:
the cohesion (dependency-injected handlers, fail-closed verification, structured `{ok,reason}`
returns, tight COSE checks) is the robustness we are adopting. **Do not dissolve these files
into the legacy `backend/src/lib/auth.ts`.**

## Provenance & license

Files under this directory that originate from DRep Talk retain their original Apache-2.0
header and carry a `// Modified for drep-platform.` note where adapted. See the root
`NOTICE` for the attribution entry. Upstream-portable fixes should be offered back to
DRep Talk as PRs.

## Stack adaptations (the seams)

DRep Talk targets Cloudflare (KV, D1, Workers, `cborg`, `@noble/curves`, `blakejs`).
drep-platform targets AWS Lambda (Node 20) with `commonjs`/classic module resolution.
The port therefore adapts at these seams rather than pulling ESM-only deps:

| Upstream primitive | drep-platform adapter |
|---|---|
| `cborg` (ESM-only, exports map) | existing `cbor-x` (`decode`/`encode`), Map-shape handling in the COSE decoder |
| `@noble/curves/ed25519` | Node `crypto` Ed25519 (the DER-prefix `verify` path already used in `auth.ts`) |
| `blakejs` blake2b | existing `blake2b` dependency |
| Cloudflare `KVNamespace` (nonces, sessions) | `NonceStore` / `SessionStore` interfaces backed by DynamoDB (`lib/dynamodb.ts`), with an explicit post-read expiry check (KV TTL → DDB TTL lag) |
| Cloudflare `D1Database` | DynamoDB item operations |
| `KoiosClient` (role resolution) | adapter over `backend/src/lib/koios.ts` |

## Invariants this module must not break

- The governance-correctness suite (`voteTally`, `committeeVoteResolver`, `cip108`,
  `rationaleAnchor`, sync) stays green. This module never edits those files.
- Every signed message binds `stage` (test signatures must not verify on prod):
  nonce payload is `${PREFIX}:${stage}:${domain}:${nonce}:${issuedAt}`.
- Verification is fail-closed: helpers return `{ ok: false, reason }`; only `ok` leaves
  the boundary.
