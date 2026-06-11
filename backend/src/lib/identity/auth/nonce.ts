// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
//
// Single-use nonce issuance and consumption for challenge-response auth flows.
// Nonces are stored in a `NonceStore` (KV-equivalent) with a 5-minute TTL and
// deleted on first use.
//
// Stack adaptations:
//   - Storage: `NonceStore` interface instead of a `KVNamespace` binding. The
//     production adapter is DDB-backed; tests use an in-memory store.
//   - Stage-binding (NEW vs DRep Talk): the payload includes `${stage}` so a
//     test-stage signature cannot verify against the prod-stage nonce table
//     even if the bytes leak. Format:
//         ${PREFIX}:${stage}:${domain}:${nonce}:${issuedAt}
//   - Per-attacker burn defense: callers can use `peekNonce` (validates without
//     deleting) then `consumeNonce` (atomic delete) after the heavy crypto
//     check passes. The legacy `lib/auth.ts` uses this same split to prevent a
//     DoS where an attacker who observes a fresh challenge burns it by
//     submitting a bogus signature. `consumeNonce` (combined check+delete) is
//     also exposed for the simple flows that don't need the split.

import { randomBytes } from 'node:crypto';
import { toBase64Url } from '../crypto/base64url';
import type { NonceStore } from '../stores/nonceStore';

const NONCE_TTL_SEC = 300;
/** Default payload prefix. drep-platform stays on the same `dreptalk` prefix
 *  to preserve byte-compat with already-issued challenges from the source
 *  fixtures and any in-flight clients. */
export const DEFAULT_PAYLOAD_PREFIX = 'dreptalk';
/** Link-flow payload prefix (Decision M1 fix, 2026-06-10 security review).
 *  A link payload binds the CALLER'S personId into the signed bytes so an
 *  attacker (person P_A) cannot get a victim to sign an opaque P_A-issued
 *  challenge that then gets verified against the victim's session as P_A.
 *  The link verify path parses the personId out of the signed payload and
 *  rejects when it differs from `authCtx.personId`. */
export const LINK_PAYLOAD_PREFIX = 'dreptalk-link';

export interface NonceOpts {
  domain: string;
  stage: string;
  /** Override for current time in seconds (defaults to Date.now()/1000). */
  now?: number;
  /** Override for the payload prefix. Defaults to `dreptalk`. */
  prefix?: string;
  /** Optional context segment embedded between the prefix and the stage —
   *  used by the link flow to bind the caller's `personId` into the
   *  signed bytes (M1 fix, 2026-06-10 security review). MUST NOT contain
   *  a colon (`:`); only ULIDs / `[A-Za-z0-9_-]+` are accepted by
   *  `parsePayload`. */
  boundContext?: string;
}

export interface NoncePayload {
  nonce: string;
  payload: string;
}

/**
 * Issues a new single-use nonce, stores it in `store`, and returns the nonce
 * and its binding payload. The payload is stage-bound: a signature produced on
 * `stage=test` cannot verify against `stage=prod` even if the byte stream is
 * replayed.
 *
 * When `boundContext` is supplied, the payload format becomes
 * `${prefix}:${boundContext}:${stage}:${domain}:${nonce}:${issuedAt}` —
 * used by the link flow to bind the caller's `personId` into the bytes the
 * wallet signs (M1 fix). The verify counterpart parses the context out and
 * rejects when it doesn't equal the calling session's personId.
 */
export async function issueNonce(store: NonceStore, opts: NonceOpts): Promise<NoncePayload> {
  const issuedAt = Math.floor(opts.now ?? Date.now() / 1000);
  const rawBytes = new Uint8Array(randomBytes(32));
  const nonce = toBase64Url(rawBytes);
  const prefix = opts.prefix ?? DEFAULT_PAYLOAD_PREFIX;
  // boundContext MUST NOT contain a colon — that would shift the column
  // shape parsePayload depends on. ULIDs (the only producer today) are
  // [0-9A-HJKMNP-TV-Z]{26} — colon-free.
  if (opts.boundContext?.includes(':')) {
    throw new Error('issueNonce: boundContext must not contain a colon');
  }
  const payload =
    opts.boundContext !== undefined
      ? `${prefix}:${opts.boundContext}:${opts.stage}:${opts.domain}:${nonce}:${issuedAt}`
      : `${prefix}:${opts.stage}:${opts.domain}:${nonce}:${issuedAt}`;
  await store.put(nonce, payload, NONCE_TTL_SEC);
  return { nonce, payload };
}

interface ParsedPayload {
  prefix: string;
  stage: string;
  domain: string;
  nonce: string;
  issuedAt: number;
  /** Present only on payloads issued with a `boundContext` (link flow).
   *  When the payload prefix is the bare `DEFAULT_PAYLOAD_PREFIX` this
   *  field is undefined; when the prefix is `LINK_PAYLOAD_PREFIX` the
   *  embedded context is parsed out and surfaced here. */
  boundContext?: string;
}

/**
 * Parses a stage-bound nonce payload. Returns null when the shape is wrong.
 *
 * The format is `${prefix}:${stage}:${domain}:${nonce}:${issuedAt}` (or
 * `${prefix}:${boundContext}:${stage}:${domain}:${nonce}:${issuedAt}` for
 * link-flow payloads — the link prefix has an extra context segment after
 * the prefix). The domain may not contain colons in practice (DNS labels),
 * and the nonce is base64url (no colons), so a simple right-anchored split
 * is unambiguous as long as we know how many trailing segments to expect.
 */
function parsePayload(payload: string, expectedPrefix: string): ParsedPayload | null {
  const parts = payload.split(':');
  const isLink = expectedPrefix === LINK_PAYLOAD_PREFIX;
  // Standard payload: prefix:stage:domain:nonce:issuedAt → ≥5 segments.
  // Link payload:     prefix:boundContext:stage:domain:nonce:issuedAt → ≥6 segments.
  const minSegments = isLink ? 6 : 5;
  if (parts.length < minSegments) return null;
  const prefix = parts[0];
  if (prefix !== expectedPrefix) return null;
  const issuedAtStr = parts[parts.length - 1];
  const nonce = parts[parts.length - 2];
  // Reject non-numeric issuedAt before parseInt coercion.
  if (issuedAtStr === undefined || !/^\d{1,15}$/.test(issuedAtStr)) return null;
  const issuedAt = Number.parseInt(issuedAtStr, 10);
  if (!Number.isFinite(issuedAt)) return null;
  if (nonce === undefined) return null;
  // For link payloads, the boundContext slot is parts[1]; stage shifts to parts[2].
  // For standard payloads, stage is parts[1] (no boundContext slot).
  const stage = isLink ? parts[2] : parts[1];
  // Domain may contain colons in theory — rebuild it from the remaining slots.
  const domainStart = isLink ? 3 : 2;
  const domain = parts.slice(domainStart, parts.length - 2).join(':');
  if (stage === undefined || domain.length === 0) return null;
  const boundContext = isLink ? parts[1] : undefined;
  if (isLink && (boundContext === undefined || boundContext.length === 0)) return null;
  return {
    prefix,
    stage,
    domain,
    nonce,
    issuedAt,
    ...(boundContext !== undefined ? { boundContext } : {}),
  };
}

export interface NonceCheckOpts {
  /** Override for current time in seconds. */
  now?: number;
  /** Maximum allowed age of the nonce in seconds (default 300). */
  maxAgeSec?: number;
  /** Required prefix; defaults to `dreptalk`. */
  prefix?: string;
  /** When set, the parsed `stage` of the payload must match — defense in
   *  depth against cross-stage replay. */
  expectedStage?: string;
}

interface NonceCheckOk {
  ok: true;
  nonce: string;
  parsed: ParsedPayload;
}

interface NonceCheckErr {
  ok: false;
  reason: string;
}

export type NonceCheck = NonceCheckOk | NonceCheckErr;

/**
 * Peek at a nonce payload: validates shape, stage, age, and presence in the
 * store WITHOUT deleting. Use this before doing the expensive signature
 * verification so a forged signature can't burn a victim's fresh nonce.
 * Returns the parsed payload on success — the caller should then run signature
 * verification and only call `consumeNonce` if it passes.
 */
export async function peekNonce(
  store: NonceStore,
  payload: string,
  opts: NonceCheckOpts = {},
): Promise<NonceCheck> {
  const prefix = opts.prefix ?? DEFAULT_PAYLOAD_PREFIX;
  const parsed = parsePayload(payload, prefix);
  if (!parsed) return { ok: false, reason: 'payload shape invalid' };

  if (opts.expectedStage !== undefined && parsed.stage !== opts.expectedStage) {
    return { ok: false, reason: 'stage mismatch' };
  }

  const now = Math.floor(opts.now ?? Date.now() / 1000);
  const maxAge = opts.maxAgeSec ?? NONCE_TTL_SEC;
  if (parsed.issuedAt > now) return { ok: false, reason: 'issuedAt in future' };
  if (now - parsed.issuedAt > maxAge) return { ok: false, reason: 'expired' };

  const stored = await store.get(parsed.nonce);
  if (stored === null) return { ok: false, reason: 'nonce absent or expired' };
  if (stored !== payload) return { ok: false, reason: 'payload mismatch' };

  return { ok: true, nonce: parsed.nonce, parsed };
}

/**
 * Atomically consume a nonce: validates it (same checks as `peekNonce`) and,
 * on success, deletes the stored record. Two concurrent consume calls cannot
 * both succeed — the conditional delete in the production DDB store fails
 * one side cleanly.
 *
 * M2 fix (2026-06-10 security review): returns the boolean from
 * `store.delete`, so a racer that lost the conditional-delete arm
 * receives `false` and does NOT mint a session. Pre-fix, the DDB
 * adapter swallowed `ConditionalCheckFailedException` as `void` and
 * this function returned `true` regardless — meaning N concurrent
 * consumers of the same signature could ALL return `true` and N
 * sessions could be minted from a single proof.
 *
 * Never throws; returns false on any failure.
 */
export async function consumeNonce(
  store: NonceStore,
  payload: string,
  opts: NonceCheckOpts = {},
): Promise<boolean> {
  try {
    const peek = await peekNonce(store, payload, opts);
    if (!peek.ok) return false;
    // M2 — propagate the atomic-delete outcome. `false` means a
    // concurrent consumer won the race; we did NOT mint a session.
    return await store.delete(peek.nonce);
  } catch {
    return false;
  }
}

/**
 * Two-phase consume: caller passes a function that runs the heavy crypto
 * check between `peek` and `delete`. The store record is only deleted if the
 * caller-supplied check returns true — preserving the per-attacker
 * burn-defense from the legacy `lib/auth.ts`.
 *
 * M2 fix (2026-06-10 security review): when `store.delete` returns
 * `false` (a concurrent consumer won the conditional-delete race),
 * surface `{ ok: false, reason: 'nonce already consumed' }` so the
 * caller MUST NOT treat the crypto pass as a session-mintable success.
 * The thrown-error path retains the same fail-closed semantics.
 *
 * Returns `{ ok: true }` if everything passes; otherwise `{ ok: false, reason }`.
 */
export async function consumeNonceWithCheck<T>(
  store: NonceStore,
  payload: string,
  check: (parsed: ParsedPayload) => Promise<
    { ok: true; value: T } | { ok: false; reason: string }
  >,
  opts: NonceCheckOpts = {},
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const peek = await peekNonce(store, payload, opts);
  if (!peek.ok) return { ok: false, reason: peek.reason };
  const checkResult = await check(peek.parsed);
  if (!checkResult.ok) return checkResult;
  let removed: boolean;
  try {
    removed = await store.delete(peek.nonce);
  } catch {
    // The atomic delete THREW — distinct from "row already gone".
    // Most often a transient DDB error; fail closed so the caller does
    // not treat the crypto pass as success when we can't prove we
    // claimed the nonce.
    return { ok: false, reason: 'nonce already consumed' };
  }
  if (!removed) {
    // The atomic delete returned `false` — a concurrent consumer won
    // the race. Fail closed: the crypto check passed but we didn't
    // claim the nonce, so we mustn't mint a session here.
    return { ok: false, reason: 'nonce already consumed' };
  }
  return { ok: true, value: checkResult.value };
}
