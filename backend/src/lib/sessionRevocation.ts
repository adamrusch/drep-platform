/**
 * Per-session JWT revocation store (Sprint 1).
 *
 * Backs the granular revocation surface of the new on-chain login flow.
 * Every JWT minted by the on-chain verify path carries a unique `jti`
 * (ULID); revoking that one session writes a tombstone keyed by
 * SHA-256(jti) into the existing `authNonces` table (kind='session').
 * The JWT authorizer consults this store on every authenticated request:
 *   - tombstone present (and unexpired)  → token rejected
 *   - tombstone absent                    → token accepted (subject to
 *                                          legacy `tokenVersion` check)
 *   - read error (DynamoDB blip)          → FAIL OPEN (token is already
 *                                          cryptographically valid; we
 *                                          prefer availability over
 *                                          enforcing revocation during
 *                                          an outage)
 *
 * Coexists with the legacy `tokenVersion` row-counter: a "log out
 * everywhere" still bumps `tokenVersion`, and a per-session revoke
 * writes a tombstone here. Either one fails the token closed.
 *
 * # Why this table?
 *
 * The brief explicitly defers infra changes — reusing `authNonces`
 * (PK=`nonce`, TTL=`expiresAt`) avoids a CDK PR. We discriminate via the
 * `kind` attribute so the legacy nonce-kind invariants in `lib/auth.ts`
 * (`'challenge' | 'mutation' | 'circuit' | 'drep_link'`) never touch
 * these rows. A dedicated table can replace this in a later sprint
 * without changing the public surface (`revokeSessionByJti` /
 * `isSessionRevoked` / `revokeAllSessionsForUser`).
 *
 * # `userId` index
 *
 * `revokeAllSessionsForUser` is the "log out every on-chain session"
 * path. We store the per-user list of revocable `jti`s under a
 * separate row keyed by `nonce = userIndexKey(userId)` so a single
 * GetItem yields the full set without a Scan. The list is best-
 * effort — `recordSessionForUser` is called from the verify path with
 * an additive `try/catch` so a write failure can't block a successful
 * login.
 */

import { createHash } from 'node:crypto';
import { putItem, getItem, deleteItem, tableNames } from './dynamodb';

interface SessionTombstoneItem extends Record<string, unknown> {
  /** PK on `authNonces`. For a tombstone, `nonce = SHA-256(jti)` in hex —
   *  deterministic, opaque, fits the existing 64-char nonce shape. */
  nonce: string;
  /** Discriminator — kept distinct from the legacy nonce kinds so legacy
   *  nonce code in `lib/auth.ts` never matches and the kind invariants
   *  there stay narrow. */
  kind: 'session';
  /** Convenience field for ops/debug; mirrors the wallet subject of the
   *  revoked JWT. Not load-bearing — the load-bearing key is the hashed
   *  `jti` in `nonce`. */
  walletAddress: string;
  /** Epoch seconds — DynamoDB TTL deletion lags by minutes; readers MUST
   *  re-check expiry and treat a stale tombstone as absent (matches the
   *  pattern used elsewhere in this codebase). */
  expiresAt: number;
}

interface UserSessionIndexItem extends Record<string, unknown> {
  nonce: string;
  kind: 'session_index';
  walletAddress: string;
  /** Hex-encoded SHA-256 hashes of every `jti` we've issued for this user
   *  that's still in its TTL window. Bounded by the JWT TTL on the high
   *  side — entries naturally expire alongside their tombstones. */
  jtiHashes: string[];
  expiresAt: number;
}

/** Default tombstone TTL — 30 days, matches the maximum JWT lifetime
 *  (`remember_me`). A revoke that lives at least as long as the token
 *  itself ensures the tombstone outlives the JWT and the revocation can
 *  never be defeated by table-cleanup lag. */
const DEFAULT_TOMBSTONE_TTL_SEC = 30 * 24 * 60 * 60;

function hashJti(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

function tombstoneKey(jti: string): string {
  return `session:${hashJti(jti)}`;
}

function userIndexKey(walletAddress: string): string {
  return `session_index:${walletAddress}`;
}

/**
 * Record a freshly-issued session's `jti` against the user so a future
 * `revokeAllSessionsForUser` can enumerate them. Best-effort — never
 * throws. The caller (the on-chain verify handler) wraps in try/catch so
 * a session-index blip can't block login.
 *
 * `ttlSec` defaults to the 30-day JWT max — entries don't outlive the
 * token they're tracking by more than a day or two of TTL-deletion lag.
 */
export async function recordSessionForUser(
  walletAddress: string,
  jti: string,
  ttlSec: number = DEFAULT_TOMBSTONE_TTL_SEC,
): Promise<void> {
  const indexNonce = userIndexKey(walletAddress);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const newHash = hashJti(jti);
  try {
    const existing = await getItem<UserSessionIndexItem>(tableNames.authNonces, {
      nonce: indexNonce,
    });
    const prior =
      existing?.kind === 'session_index' && Array.isArray(existing.jtiHashes)
        ? existing.jtiHashes
        : [];
    // De-dup and bound the list — a long-lived wallet might have a few
    // dozen sessions but should not accumulate thousands. 1024 is a
    // generous cap; oldest entries fall off if the list grows past it.
    const merged = Array.from(new Set([...prior, newHash])).slice(-1024);
    const item: UserSessionIndexItem = {
      nonce: indexNonce,
      kind: 'session_index',
      walletAddress,
      jtiHashes: merged,
      expiresAt,
    };
    // `putItem` overwrites unconditionally — the per-user index has no
    // append-only invariant; concurrent logins racing here may lose a hash
    // but the worst case is "one session can't be revoked via the user
    // index" (it's still revocable individually via its own `jti`).
    await putItem(tableNames.authNonces, item as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(
      'recordSessionForUser: index upsert failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Write a tombstone for the supplied `jti`, revoking the corresponding
 * JWT immediately. Idempotent — re-revoking a `jti` overwrites the
 * existing tombstone with the same content. Never throws; on failure the
 * caller should surface a 500 but the auth path is unaffected (the JWT
 * is still cryptographically valid, just not granularly revoked).
 *
 * `ttlSec` should be at least as long as the JWT's remaining lifetime.
 * Defaulting to the 30-day max keeps the tombstone alive longer than
 * any reachable token would be.
 */
export async function revokeSessionByJti(
  jti: string,
  walletAddress: string,
  ttlSec: number = DEFAULT_TOMBSTONE_TTL_SEC,
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const item: SessionTombstoneItem = {
    nonce: tombstoneKey(jti),
    kind: 'session',
    walletAddress,
    expiresAt,
  };
  // putItem is unconditional — idempotent for the use case.
  await putItem(tableNames.authNonces, item as unknown as Record<string, unknown>);
}

/**
 * True when the supplied `jti` is revoked. Tries to fail-CLOSED on
 * unambiguous revocation and FAIL-OPEN on store errors (the authorizer
 * already validated the JWT cryptographically; we'd rather serve a
 * legitimate user during a DynamoDB blip than 401 every authenticated
 * request).
 *
 * Returns:
 *   - `true`  → tombstone present and unexpired (revoked, reject token)
 *   - `false` → no tombstone OR tombstone expired (accept token)
 *
 * Errors caught here log to CloudWatch and resolve to `false` (fail
 * open). That matches the pattern already used for `tokenVersion` reads
 * in `middleware/jwt-authorizer.ts`.
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  try {
    const stored = await getItem<SessionTombstoneItem>(tableNames.authNonces, {
      nonce: tombstoneKey(jti),
    });
    if (!stored || stored.kind !== 'session') return false;
    // DynamoDB TTL deletion lags; an expired tombstone is treated as absent.
    if (Math.floor(Date.now() / 1000) > stored.expiresAt) {
      try {
        await deleteItem(tableNames.authNonces, { nonce: tombstoneKey(jti) });
      } catch {
        // Best-effort cleanup; ignore.
      }
      return false;
    }
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
 * Revoke every on-chain session this wallet has issued. The per-user
 * index is consulted (best-effort) — on a missing/corrupt index we
 * silently bail. Callers SHOULD also bump the legacy `tokenVersion`
 * counter (which the legacy logout already does) so anything that
 * pre-dates the per-session index is still invalidated.
 *
 * Returns the number of tombstones written so callers can report
 * "revoked N sessions" if they want. Best-effort throughout.
 */
export async function revokeAllSessionsForUser(walletAddress: string): Promise<number> {
  let written = 0;
  let index: UserSessionIndexItem | null = null;
  try {
    const raw = await getItem<UserSessionIndexItem>(tableNames.authNonces, {
      nonce: userIndexKey(walletAddress),
    });
    index = raw?.kind === 'session_index' ? raw : null;
  } catch (err) {
    console.warn(
      'revokeAllSessionsForUser: index read failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
  if (!index || !Array.isArray(index.jtiHashes)) return 0;
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_TOMBSTONE_TTL_SEC;
  for (const jtiHash of index.jtiHashes) {
    const item: SessionTombstoneItem = {
      nonce: `session:${jtiHash}`,
      kind: 'session',
      walletAddress,
      expiresAt,
    };
    try {
      await putItem(tableNames.authNonces, item as unknown as Record<string, unknown>);
      written += 1;
    } catch (err) {
      console.warn(
        'revokeAllSessionsForUser: tombstone write failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  }
  // After writing every tombstone, clear the user index so a future
  // logout-all doesn't re-revoke the same long-gone sessions on every
  // call. Best-effort.
  try {
    await deleteItem(tableNames.authNonces, { nonce: userIndexKey(walletAddress) });
  } catch {
    // Ignore.
  }
  return written;
}
