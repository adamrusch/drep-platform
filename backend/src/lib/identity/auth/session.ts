// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
//
// Opaque KV-style session storage with sliding TTL and per-user revocation.
// Tokens are stored hashed (SHA-256) so a store dump never yields usable bearer
// tokens.
//
// Stack adaptations:
//   - Storage: `SessionStore` interface (`stores/sessionStore.ts`) instead of
//     a Cloudflare KVNamespace. The shape is identical — string blobs under
//     SHA-256-derived keys, with an explicit TTL hint.
//   - SHA-256 + random bytes: Node `crypto` instead of WebCrypto. The two are
//     interchangeable; we use the sync `createHash` for SHA-256 because the
//     payload is tiny and the call site is hot.
//   - The cookie shape (name, flags, format) is preserved verbatim from
//     DRep Talk so a future cutover can swap the legacy `lib/auth.ts` cookie
//     code for this module's without breaking existing in-flight tokens —
//     though no production code reads this cookie yet (the legacy
//     `cookieName()` is stage-stamped; here we keep the DRep Talk default
//     and let the caller override).

import { createHash, randomBytes } from 'node:crypto';
import { toBase64Url } from '../crypto/base64url';
import { bytesToHex } from '../crypto/hex';
import type { SessionStore } from '../stores/sessionStore';

const SESSION_TTL_SEC = 2_592_000; // 30 days
const SLIDING_WINDOW_SEC = 21_600; // 6 hours
const DEFAULT_SESSION_COOKIE_NAME = 'dreptalk_session';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  userId: string;
  roles: string[];
  createdAt: number;
  lastSeen: number;
}

export interface SessionOpts {
  now?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the SHA-256 digest of a UTF-8 string as a lowercase hex string. */
function sha256hex(input: string): string {
  return bytesToHex(new Uint8Array(createHash('sha256').update(input).digest()));
}

/** Store key for a session record, derived from the token hash. */
function sessKey(keyHash: string): string {
  return `sess:${keyHash}`;
}

/** Store key for the per-user session index. */
function usessKey(userId: string): string {
  return `usess:${userId}`;
}

/**
 * Reads the per-user session hash index from the store.
 * Returns an empty array if the key is absent or the stored value is corrupt JSON.
 */
async function readHashIndex(store: SessionStore, userId: string): Promise<string[]> {
  const raw = await store.get(usessKey(userId));
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new session for a user. Returns the opaque bearer token.
 * The token itself is never stored; only its SHA-256 hash is used as a key.
 */
export async function createSession(
  store: SessionStore,
  user: { id: string; roles: string[] },
  opts?: SessionOpts,
): Promise<string> {
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const rawBytes = new Uint8Array(randomBytes(32));
  const token = toBase64Url(rawBytes);
  const keyHash = sha256hex(token);

  const record: SessionRecord = {
    userId: user.id,
    roles: user.roles,
    createdAt: now,
    lastSeen: now,
  };

  // Store session record and read per-user index concurrently (different keys).
  const [, hashes] = await Promise.all([
    store.put(sessKey(keyHash), JSON.stringify(record), SESSION_TTL_SEC),
    readHashIndex(store, user.id),
  ]);

  // Append new hash and write updated index.
  hashes.push(keyHash);
  await store.put(usessKey(user.id), JSON.stringify(hashes), SESSION_TTL_SEC);

  return token;
}

/**
 * Retrieves a session record by token. Returns null if the token is unknown.
 * Lazily refreshes lastSeen (and resets the TTL) at most once per 6 hours.
 */
export async function getSession(
  store: SessionStore,
  token: string,
  opts?: SessionOpts,
): Promise<SessionRecord | null> {
  try {
    const now = Math.floor(opts?.now ?? Date.now() / 1000);
    const keyHash = sha256hex(token);
    const raw = await store.get(sessKey(keyHash));
    if (raw === null) return null;

    const record: SessionRecord = JSON.parse(raw) as SessionRecord;

    // Lazy sliding renewal: refresh at most once per 6-hour window.
    if (now - record.lastSeen > SLIDING_WINDOW_SEC) {
      record.lastSeen = now;
      const [, indexRaw] = await Promise.all([
        store.put(sessKey(keyHash), JSON.stringify(record), SESSION_TTL_SEC),
        store.get(usessKey(record.userId)),
      ]);
      // Also refresh the per-user index TTL so it never expires before live sessions.
      if (indexRaw !== null) {
        await store.put(usessKey(record.userId), indexRaw, SESSION_TTL_SEC);
      }
    }

    return record;
  } catch {
    return null;
  }
}

/**
 * Revokes a single session by deleting its store record and removing the hash
 * from the per-user index to prevent unbounded index growth.
 */
export async function revokeSession(store: SessionStore, token: string): Promise<void> {
  const keyHash = sha256hex(token);
  // Read the record first so we know which user's index to prune.
  const raw = await store.get(sessKey(keyHash));
  await store.delete(sessKey(keyHash));
  if (raw !== null) {
    try {
      const record = JSON.parse(raw) as SessionRecord;
      const hashes = await readHashIndex(store, record.userId);
      const pruned = hashes.filter(h => h !== keyHash);
      if (pruned.length > 0) {
        await store.put(usessKey(record.userId), JSON.stringify(pruned), SESSION_TTL_SEC);
      } else {
        await store.delete(usessKey(record.userId));
      }
    } catch {
      // Session key is already deleted; nothing more to do.
    }
  }
}

/**
 * Revokes all sessions for a user by reading their index and deleting every
 * session record, then removing the index itself.
 *
 * Note: the read-modify-write on the per-user index is not atomic. A concurrent
 * createSession during revokeAllForUser may result in the new session surviving
 * or the index entry being lost. This is an acceptable race for the use-case
 * (logout-all; the new session was created after the logout intent).
 */
export async function revokeAllForUser(store: SessionStore, userId: string): Promise<void> {
  const raw = await store.get(usessKey(userId));
  if (!raw) return;
  // On corrupt index: delete the index key and return; nothing safely revocable.
  let hashes: string[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      await store.delete(usessKey(userId));
      return;
    }
    hashes = parsed as string[];
  } catch {
    await store.delete(usessKey(userId));
    return;
  }
  await Promise.all(hashes.map(h => store.delete(sessKey(h))));
  await store.delete(usessKey(userId));
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export interface CookieOpts {
  /** Defaults to true (production). Pass `false` to omit the Secure flag for
   *  local http dev. */
  secure?: boolean;
  /** Optional cookie name override. Defaults to `dreptalk_session`. */
  cookieName?: string;
}

/**
 * Builds a Set-Cookie header value for the session token.
 * Flags: HttpOnly, SameSite=Lax, Path=/, Max-Age=30d, and Secure by default.
 */
export function buildSessionCookie(token: string, opts?: CookieOpts): string {
  const secureFlag = opts?.secure !== false ? '; Secure' : '';
  const name = opts?.cookieName ?? DEFAULT_SESSION_COOKIE_NAME;
  return `${name}=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}

/** Builds a Set-Cookie header value that clears the session cookie. */
export function clearSessionCookie(opts?: { cookieName?: string }): string {
  const name = opts?.cookieName ?? DEFAULT_SESSION_COOKIE_NAME;
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Parses the session token from a Cookie header value.
 * Returns null if the cookie is absent or the header is null.
 */
export function parseSessionToken(
  cookieHeader: string | null,
  opts?: { cookieName?: string },
): string | null {
  if (!cookieHeader) return null;
  const name = opts?.cookieName ?? DEFAULT_SESSION_COOKIE_NAME;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...valueParts] = part.trim().split('=');
    if (rawName !== undefined && rawName.trim() === name) {
      return valueParts.join('=').trim() || null;
    }
  }
  return null;
}
