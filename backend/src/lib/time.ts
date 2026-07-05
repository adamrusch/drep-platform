/**
 * Tiny shared time helpers.
 *
 * # Why this file exists
 *
 * `Math.floor(Date.now() / 1000)` and `new Date().toISOString()` appeared
 * literally in ~50 places across handlers + syncs — every DynamoDB TTL
 * write, every audit log, every session mint. The DRY consolidation
 * (2026-07-04 code review, Pass 4) folds them into two named functions
 * so that:
 *
 *   1. Test mocks that need to freeze time can `vi.spyOn(time, 'nowSec')`
 *      once instead of monkey-patching `Date.now` on every module.
 *   2. A future migration to explicit UTC (e.g. Temporal, or a Cardano-
 *      epoch-aware clock) has one seam to change.
 *   3. The unit — `Sec` — is in the function name, so a caller can't
 *      accidentally treat the return as milliseconds.
 *
 * # Not consolidated
 *
 * The identity subsystem under `lib/identity/**` intentionally keeps its
 * own `defaultNow: NowFn = () => Math.floor(Date.now() / 1000)` at
 * `stores/nonceStore.ts:48` and `stores/sessionStore.ts:23`. Those are
 * dependency-injection seams from the ported DRep Talk code — replacing
 * them with a call into this module would tangle the subsystem's DI
 * contract. Same for `sessionRevocation.ts`, which is under the identity
 * security review's freeze.
 */

/** Wall-clock time in Unix seconds. Integer. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Wall-clock time as an ISO-8601 UTC string, e.g. `2026-07-04T12:34:56.789Z`. */
export function nowISO(): string {
  return new Date().toISOString();
}
