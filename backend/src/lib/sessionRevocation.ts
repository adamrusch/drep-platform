/**
 * Per-session JWT revocation store, backed by the dedicated
 * `identity_sessions` DynamoDB table (Decision #1, 2026-06-10).
 *
 * Backs the granular revocation surface of the on-chain login flow.
 * Every JWT minted by the on-chain verify path carries a unique `jti`
 * (ULID); on login we write a session row keyed by SHA-256(jti); on
 * revocation we mark the same row `revoked:true`. The JWT authorizer
 * consults this store on every authenticated request:
 *   - row present with `revoked:true` (and unexpired) → token rejected
 *   - row absent, OR row present with `revoked:false` → token accepted
 *                                          (subject to legacy
 *                                          `tokenVersion` check)
 *   - read error (DynamoDB blip)          → FAIL OPEN (token is already
 *                                          cryptographically valid; we
 *                                          prefer availability over
 *                                          enforcing revocation during
 *                                          an outage)
 *
 * Coexists with the legacy `tokenVersion` row-counter: a "log out
 * everywhere" still bumps `tokenVersion`, and a per-session revoke
 * marks the row. Either one fails the token closed.
 *
 * # Why a dedicated table (Decision #1, 2026-06-10)
 *
 * Sprint 1 reused `authNonces` with a `kind` discriminator (`'session'`
 * / `'session_index'`) to defer infra changes. Decision #1 splits
 * sessions off into a purpose-built table for three concrete wins:
 *
 *   1. **A GSI for cheap enumeration.** Sprint-3 added the daily
 *      role-revalidation cron, which previously paid for a filtered
 *      Scan of the shared `authNonces` table to enumerate active
 *      session indices. With a dedicated table and a per-identity
 *      GSI, "list every active session for one identity" is a
 *      single-partition Query.
 *   2. **`revokeAllSessionsForUser` does the same Query** instead of
 *      reading a per-user "index row" maintained by best-effort
 *      writes — a race-y design where a concurrent login could lose a
 *      hash and leave a session out of the revoke-all set. Reading
 *      the GSI removes the index row entirely.
 *   3. **One row per session.** Active state + revoked state live on
 *      the same primary key. No more "tombstone" vs "session_index"
 *      split, no more two rows to keep in sync.
 *
 * # Table schema
 *
 *   PK = `sessionKey` (STRING)  = SHA-256(jti) in hex (64 chars).
 *        Deterministic, opaque, identical-shape to the prior
 *        `tombstoneKey`'s hash component so the migration is
 *        meaning-preserving — only the table changes.
 *   TTL = `expiresAt` (NUMBER, epoch seconds). DynamoDB-managed delete
 *         lags by minutes; readers MUST re-check expiry and treat a
 *         stale row as absent (matches the pattern used elsewhere).
 *   Attributes:
 *     - `identityId` (STRING) — the on-chain credential the JWT's
 *       `sub` carries. Same value the legacy `walletAddress` field
 *       did, renamed to reflect the on-chain semantic.
 *     - `onChainRoles` (LIST<STRING>) — the role set the session was
 *       granted under. The cron's role-revalidation reads this to know
 *       which `resolveRole` variant to re-run.
 *     - `issuedAt` (NUMBER, epoch seconds) — used as the GSI SK so the
 *       per-identity enumeration is sortable.
 *     - `expiresAt` (NUMBER) — TTL attribute; also used by readers to
 *       detect stale rows.
 *     - `revoked` (BOOLEAN, optional) — `true` when the session was
 *       revoked. Missing / false = active.
 *   GSI: `identityId-issuedAt-index`
 *     PK = `identityId`, SK = `issuedAt`, projection ALL so a single
 *     Query yields the full row set the cron's enumerator needs.
 *
 * The `walletAddress` parameter names on the public functions below
 * are preserved for caller compatibility — semantically they now
 * carry the on-chain `identityId` (which is what the legacy callers
 * already passed: the JWT `sub` of an on-chain login).
 */

import { createHash } from 'node:crypto';
import {
  putItem,
  getItem,
  updateItem,
  queryItems,
  scanItems,
  tableNames,
} from './dynamodb';
import type { OnChainRole } from './types';

interface SessionRow extends Record<string, unknown> {
  /** PK on `identity_sessions`. SHA-256(jti) in hex (64 chars). */
  sessionKey: string;
  /** The on-chain identity (drep1... / stake1... / pool1... / cc_cold1...).
   *  Mirrors the wallet subject of the JWT. Indexed via the
   *  `identityId-issuedAt-index` GSI so per-identity enumeration is a
   *  single-partition Query (used by revoke-all + the role-revalidation
   *  cron). */
  identityId: string;
  /** The on-chain roles this session was granted under. Always an array,
   *  may be empty in defensive code paths (a pre-Decision-1 record could
   *  in theory have lacked this — those rows are migrating naturally as
   *  they age out via TTL). */
  onChainRoles: OnChainRole[];
  /** Epoch seconds the session was issued. Used as the GSI SK so the
   *  cron's enumeration is sortable, and so a future "newest N sessions
   *  per identity" surface gets a cheap partition Query. */
  issuedAt: number;
  /** Epoch seconds — DynamoDB TTL attribute. Readers MUST re-check
   *  expiry (DDB TTL deletion lags by minutes) and treat a stale row as
   *  absent — matches the pattern used elsewhere in this codebase. */
  expiresAt: number;
  /** True after a revoke. Missing / false = active. */
  revoked?: boolean;
}

/** Default TTL — 30 days, matches the maximum JWT lifetime
 *  (`remember_me`). A revoke that lives at least as long as the token
 *  itself ensures the revocation can never be defeated by table-cleanup
 *  lag. */
const DEFAULT_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

function hashJti(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

/**
 * Record a freshly-issued session against the identity so the
 * authorizer's revocation check + revoke-all + cron enumeration can
 * find it. Best-effort — never throws. The caller (the on-chain verify
 * handler) wraps in try/catch so a write blip can't block login.
 *
 * `ttlSec` defaults to the 30-day JWT max — rows are removed by DDB TTL
 * after the JWT can no longer be presented anyway.
 *
 * `onChainRole` — the on-chain role(s) the session was granted under.
 * For the four-role on-chain login each session carries exactly one
 * role; the schema stores it as an array for forward-compatibility
 * with future multi-role sessions (no migration needed) and to keep
 * the cron's read path uniform.
 *
 * Public signature (parameter NAMES preserved) for backward
 * compatibility — semantically `walletAddress` here is the on-chain
 * identity id (the JWT `sub`), which is what every caller already
 * passes.
 */
export async function recordSessionForUser(
  walletAddress: string,
  jti: string,
  onChainRole?: OnChainRole,
  ttlSec: number = DEFAULT_SESSION_TTL_SEC,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const row: SessionRow = {
    sessionKey: hashJti(jti),
    identityId: walletAddress,
    onChainRoles: onChainRole ? [onChainRole] : [],
    issuedAt: nowSec,
    expiresAt: nowSec + ttlSec,
    revoked: false,
  };
  try {
    // Unconditional Put: a row at this `sessionKey` (SHA-256(jti))
    // can only exist if the same `jti` was previously issued — the
    // jti is a ULID so collisions are astronomically unlikely. The
    // worst case is overwriting a freshly-issued row with the same
    // content. We deliberately do NOT use `attribute_not_exists` —
    // a flake on the write path under that condition would 500 the
    // login, which is worse than the (impossible) collision case.
    await putItem(tableNames.identitySessions, row);
  } catch (err) {
    console.warn(
      'recordSessionForUser: session write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Mark the supplied `jti`'s session as revoked. Idempotent — re-revoking
 * an already-revoked row is a no-op. The row is also re-written from
 * scratch when the original `recordSessionForUser` missed (e.g. a write
 * blip at login time) so the next `isSessionRevoked` returns `true`
 * even in that degenerate case.
 *
 * `ttlSec` should be at least as long as the JWT's remaining lifetime;
 * defaulting to the 30-day max ensures the revoke outlives any
 * reachable token.
 *
 * Throws on a hard DDB error so the caller can surface a 500 — but the
 * caller's contract (the logout handler) already wraps this in a
 * try/catch and never lets the failure block the cookie-clear path.
 */
export async function revokeSessionByJti(
  jti: string,
  walletAddress: string,
  ttlSec: number = DEFAULT_SESSION_TTL_SEC,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionKey = hashJti(jti);
  try {
    // Fast path — the row exists from `recordSessionForUser`. Flip
    // `revoked` to true and extend `expiresAt` to the requested TTL
    // (in case the JWT outlives the original row's TTL — `ttlSec` is
    // the JWT's remaining lifetime per the docblock). `SET` is
    // idempotent.
    await updateItem(
      tableNames.identitySessions,
      { sessionKey },
      'SET #revoked = :true, #expiresAt = :exp',
      { '#revoked': 'revoked', '#expiresAt': 'expiresAt' },
      { ':true': true, ':exp': nowSec + ttlSec },
    );
  } catch (err) {
    // The row didn't exist — `recordSessionForUser` missed at login
    // time (rare; best-effort write). Insert a revoked-by-default row
    // directly so `isSessionRevoked` returns `true` for this jti.
    console.warn(
      'revokeSessionByJti: update on existing row failed; writing fresh revoked row:',
      err instanceof Error ? err.message : err,
    );
    const row: SessionRow = {
      sessionKey,
      identityId: walletAddress,
      onChainRoles: [],
      issuedAt: nowSec,
      expiresAt: nowSec + ttlSec,
      revoked: true,
    };
    await putItem(tableNames.identitySessions, row);
  }
}

/**
 * True when the supplied `jti` is revoked. Tries to fail-CLOSED on
 * unambiguous revocation and FAIL-OPEN on store errors (the authorizer
 * already validated the JWT cryptographically; we'd rather serve a
 * legitimate user during a DynamoDB blip than 401 every authenticated
 * request).
 *
 * Returns:
 *   - `true`  → row present, `revoked === true`, AND unexpired
 *               (revoked, reject token)
 *   - `false` → row absent, OR `revoked !== true`, OR row expired
 *               (accept token)
 *
 * Errors caught here log to CloudWatch and resolve to `false` (fail
 * open). That matches the pattern already used for `tokenVersion` reads
 * in `middleware/jwt-authorizer.ts`.
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  try {
    const stored = await getItem<SessionRow>(tableNames.identitySessions, {
      sessionKey: hashJti(jti),
    });
    if (!stored) return false;
    if (stored.revoked !== true) return false;
    // DynamoDB TTL deletion lags; an expired row is treated as absent.
    if (Math.floor(Date.now() / 1000) > stored.expiresAt) return false;
    return true;
  } catch (err) {
    console.warn(
      'isSessionRevoked: store read failed, failing open:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Revoke every on-chain session this identity has issued. Enumerates
 * via the `identityId-issuedAt-index` GSI — single-partition Query, no
 * Scan. For each active row, flip `revoked:true`. Already-revoked rows
 * are skipped (no-op). Returns the number of rows newly revoked this
 * call.
 *
 * Best-effort throughout — per-row update failures log + count under
 * `revokeErrors` upstream. A GSI read failure returns 0 so the caller
 * can surface the failure without blocking the legacy `tokenVersion`
 * bump path (which is the authoritative "log out everywhere" for
 * legacy CIP-30 sessions anyway).
 */
export async function revokeAllSessionsForUser(walletAddress: string): Promise<number> {
  let written = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const newExpiresAt = nowSec + DEFAULT_SESSION_TTL_SEC;
  let cursor: Record<string, unknown> | undefined;
  do {
    let page;
    try {
      page = await queryItems<SessionRow>(tableNames.identitySessions, {
        indexName: 'identityId-issuedAt-index',
        keyConditionExpression: '#identityId = :identityId',
        expressionAttributeNames: { '#identityId': 'identityId' },
        expressionAttributeValues: { ':identityId': walletAddress },
        ...(cursor ? { exclusiveStartKey: cursor } : {}),
      });
    } catch (err) {
      console.warn(
        'revokeAllSessionsForUser: GSI Query failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
      return written;
    }
    for (const row of page.items) {
      // Skip already-revoked rows so the count is "rows newly
      // revoked this call" — the caller's revokedCount surfaces in
      // the logout response and a re-logout shouldn't inflate it.
      if (row.revoked === true) continue;
      // Skip rows past their expiry — DDB TTL lag means we may see
      // stale rows; revoking one is harmless but wastes a write.
      if (typeof row.expiresAt === 'number' && row.expiresAt < nowSec) continue;
      try {
        await updateItem(
          tableNames.identitySessions,
          { sessionKey: row.sessionKey },
          'SET #revoked = :true, #expiresAt = :exp',
          { '#revoked': 'revoked', '#expiresAt': 'expiresAt' },
          { ':true': true, ':exp': newExpiresAt },
        );
        written += 1;
      } catch (err) {
        console.warn(
          'revokeAllSessionsForUser: per-row revoke failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }
    }
    cursor = page.lastEvaluatedKey;
  } while (cursor);
  return written;
}

// ---------------------------------------------------------------------------
// Enumeration for the daily role-revalidation cron (Sprint 3, ported)
// ---------------------------------------------------------------------------

/** One active on-chain identity surfaced by `listActiveSessionIndices`.
 *
 * Shape preserved across Decision #1 so the daily cron
 * (`sync/revalidate-onchain-roles.ts`) requires no changes — same
 * `walletAddress` / `onChainRole` / `jtiHashes` / `expiresAt` fields.
 * Backed by the new `identity_sessions` table; the cron is none the
 * wiser. */
export interface ActiveSessionIndex {
  /** The on-chain credential identifier — drep1... / stake1... /
   *  pool1... / cc_cold1... depending on the role. Same string the
   *  identity's JWT `sub` carries. */
  walletAddress: string;
  /** The role this identity's sessions were granted under. We
   *  collapse the first non-empty `onChainRoles[]` entry from the
   *  identity's session rows — every session for an identity is
   *  granted under exactly one role today. `undefined` only on
   *  pre-Decision-1 rows that may have lacked the field (those age
   *  out via TTL). */
  onChainRole: OnChainRole | undefined;
  /** The hashed-jti list (SHA-256(jti) values, i.e. `sessionKey`s)
   *  for this identity's still-active sessions. Mirrors the prior
   *  shape so the cron's `isSessionRevoked` per-jti loop (if any)
   *  is unchanged. */
  jtiHashes: string[];
  /** Latest `expiresAt` across the identity's active session rows.
   *  Already-expired rows are filtered out by the enumerator before
   *  they reach the caller (DDB TTL deletion lags by minutes, so the
   *  explicit check is required for correctness — matches the prior
   *  contract). */
  expiresAt: number;
}

/**
 * Enumerate every active per-identity session. Used by the daily
 * role-revalidation cron (`sync/revalidate-onchain-roles.ts`) to fan out
 * one role re-check per identity.
 *
 * # Implementation
 *
 * Scans the new dedicated `identity_sessions` table filtering rows
 * where `revoked != true` and `expiresAt > now`, then groups by
 * `identityId` and folds each identity's rows into one
 * `ActiveSessionIndex` entry. A future optimisation could maintain a
 * sparse-by-identity index, but a Scan of a single-purpose table
 * (scoped to active on-chain sessions only) is cheap at today's scale
 * — the prior implementation scanned the shared `authNonces` table
 * with a more expensive `kind='session_index'` filter and a wider
 * partition set.
 *
 * # Defensive
 *
 *   - Filters expired rows (DDB TTL lag).
 *   - Filters rows whose `identityId` isn't a string (defensive
 *     against schema drift).
 *   - Caller pages with `lastEvaluatedKey` until DDB reports none.
 *
 * Read errors propagate — the cron decides whether to fail-safe (skip
 * the whole pass) or treat the partial enumeration as authoritative.
 * Today's cron treats a thrown Scan as a hard fail (it logs and exits
 * the run without revoking anything) so a transient DDB blip never
 * locks every on-chain identity out.
 */
export async function listActiveSessionIndices(): Promise<ActiveSessionIndex[]> {
  // identityId → folded ActiveSessionIndex (jtiHashes appended, latest
  // expiresAt + onChainRole carried forward).
  const byIdentity = new Map<string, ActiveSessionIndex>();
  let cursor: Record<string, unknown> | undefined;
  const nowSec = Math.floor(Date.now() / 1000);
  do {
    const page = await scanItems<SessionRow>(tableNames.identitySessions, {
      // Filter out revoked rows + already-expired rows server-side so
      // the per-page payload is just the active set.
      filterExpression:
        '(attribute_not_exists(#revoked) OR #revoked = :false) AND #expiresAt > :now',
      expressionAttributeNames: {
        '#revoked': 'revoked',
        '#expiresAt': 'expiresAt',
      },
      expressionAttributeValues: { ':false': false, ':now': nowSec },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    for (const row of page.items) {
      if (typeof row.identityId !== 'string' || row.identityId.length === 0) {
        continue;
      }
      if (typeof row.expiresAt !== 'number' || row.expiresAt < nowSec) {
        // Filter-expression should already exclude these, but DDB
        // returns ConsumedCapacity-based pages so a stale row may
        // squeak through under race conditions. Cheap to re-check.
        continue;
      }
      const role: OnChainRole | undefined =
        Array.isArray(row.onChainRoles) && row.onChainRoles.length > 0
          ? (row.onChainRoles[0] as OnChainRole)
          : undefined;
      const existing = byIdentity.get(row.identityId);
      if (!existing) {
        byIdentity.set(row.identityId, {
          walletAddress: row.identityId,
          onChainRole: role,
          jtiHashes: [row.sessionKey],
          expiresAt: row.expiresAt,
        });
      } else {
        existing.jtiHashes.push(row.sessionKey);
        if (row.expiresAt > existing.expiresAt) {
          existing.expiresAt = row.expiresAt;
        }
        // Don't overwrite a known role with `undefined` from a
        // pre-Decision-1 row; prefer a real role on any session row
        // we've seen for this identity.
        if (!existing.onChainRole && role) {
          existing.onChainRole = role;
        }
      }
    }
    cursor = page.lastEvaluatedKey;
  } while (cursor);
  return Array.from(byIdentity.values());
}
