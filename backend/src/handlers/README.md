# `backend/src/handlers/`

HTTP API handlers, one per route. Wired up by `infra/lib/api-stack.ts`
to API Gateway HTTP API v2.

## Handler tree

```
handlers/
├── _response.ts                 # shared OK/error JSON response helpers
├── auth/
│   ├── challenge.ts             # POST /auth/challenge        (public)
│   ├── verify.ts                # POST /auth/verify           (public)
│   ├── refresh.ts               # POST /auth/refresh          (auth)
│   ├── logout.ts                # DELETE /auth/session        (auth)
│   ├── me.ts                    # GET /auth/me                (auth)
│   └── mutationNonce.ts         # POST /auth/mutation-nonce   (auth)
├── governance/
│   ├── list.ts                  # GET /governance             (public)
│   ├── get.ts                   # GET /governance/{actionId}  (public)
│   ├── stats.ts                 # GET /governance/stats       (public)
│   └── sync.ts                  # POST /governance/sync       (auth, manual trigger)
├── directory/
│   ├── list.ts                  # GET /dreps                  (public, cached)
│   └── get.ts                   # GET /dreps/{drepId}         (public, cached)
├── drep/
│   ├── list.ts                  # GET /drep                   (committee list)
│   ├── get.ts                   # GET /drep/{drepId}          (committee detail)
│   ├── register.ts              # POST /drep                  (auth)
│   └── update.ts                # PUT /drep/{drepId}          (auth)
├── comments/
│   ├── list.ts                  # GET /comments/{actionId}    (public)
│   ├── create.ts                # POST /comments/{actionId}   (auth + nonce)
│   └── delete.ts                # DELETE /comments/{actionId}/{commentId} (auth)
├── clubhouse/
│   ├── list.ts                  # GET /clubhouse/{drepId}     (public)
│   ├── createPost.ts            # POST /clubhouse/{drepId}/post (auth + nonce)
│   ├── createComment.ts         # POST /clubhouse/{drepId}/post/{postId}/comment (auth)
│   ├── deletePost.ts            # DELETE /clubhouse/{drepId}/post/{postId} (auth)
│   └── votePoll.ts              # POST /clubhouse/{drepId}/post/{postId}/vote (auth, JWT-only)
├── profile/
│   ├── get.ts                   # GET /profile/{walletAddress}            (public)
│   ├── upsert.ts                # POST /profile                           (auth)
│   └── delegationHistory.ts     # GET /profile/{walletAddress}/delegation-history (auth — Blockfrost-bound, gated to prevent quota amplification)
└── epoch/
    └── get.ts                   # GET /epoch                  (public, cached)
```

## Conventions

- One handler per file. Each exports `handler` (the Lambda entry point)
  and optionally a unit-testable inner function.
- Routes that mutate state require both a JWT cookie AND a single-use
  mutation nonce (`POST /auth/mutation-nonce` to obtain). Exception:
  poll voting (trade-off documented inline).
- Read endpoints emit `Cache-Control: public, max-age=…, s-maxage=…`
  via `_response.ts` helpers. CloudFront honors `s-maxage` and the
  browser uses `max-age`. See `docs/ARCHITECTURE.md` for the cache
  layering.
- Validation is handler-side. We don't use API Gateway request
  validation (HTTP API v2 doesn't expose it the same way REST does, and
  Lambda-level is more flexible).
- Errors return `{"error": string, "code": string}` JSON via
  `_response.ts`. Status codes follow conventional HTTP semantics
  (see `docs/RUNBOOK.md` for the full list).

## Adding a new handler

1. Create `handlers/<group>/<verb>.ts`. Match the existing file naming
   conventions (`list.ts` for collection GET, `get.ts` for single-item
   GET, `create.ts` / `delete.ts` / `update.ts` for mutations).
2. Wire it into `infra/lib/api-stack.ts` — add the Lambda definition
   under the matching `// ---- <group> handlers ----` block, and add
   the route under `// ---- <group> routes ----`.
3. If the route needs auth, pass `true` to `addRoute(...)`. The JWT
   authorizer Lambda is already wired in.
4. Add tests if the handler has non-trivial logic (we have no test
   harness yet — see `RESUME.md` "Phase 1-D" notes).
5. Update `docs/RUNBOOK.md`'s error-code table if the handler returns
   a non-obvious status code.
