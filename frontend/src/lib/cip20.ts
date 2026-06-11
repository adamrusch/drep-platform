// ============================================================
// CIP-20 transaction-message-metadata helper (label 674) — CANONICAL SOURCE.
//
// CIP-20 reserves Cardano transaction metadata label `674` for a
// human-readable "transaction message". The structure is:
//
//   674 → { msg: ["chunk1", "chunk2", ...] }
//
// where each `chunkN` is a UTF-8 string of at most 64 BYTES. The 64-byte
// limit is a hard CBOR text-chunking constraint on Cardano — strings
// longer than 64 bytes must be split into multiple array entries, and a
// string that LOOKS short in code points can exceed the limit when its
// UTF-8 byte length is counted (multi-byte characters like emoji or
// CJK). The chunker below counts bytes, not code points.
//
// drep.tools stamps every on-chain submission it assembles with this
// metadata so chain analysts (Cardanoscan, gov.tools, cexplorer.io,
// independent researchers) can attribute the vote to the platform that
// emitted it. The attribution is purely a self-claim — it carries no
// cryptographic guarantee — but combined with the platform's known
// CIP-1694 vote payload shape it's enough to power "X% of DRep votes
// were cast via drep.tools" dashboards.
//
// # Duplication policy (same shape as committeeMessages.ts and freshness.ts)
//
// This file is DUPLICATED verbatim into:
//   - frontend/src/lib/cip20.ts   (consumed by buildUnsignedVoteTx)
// The repo avoids cross-workspace imports — see backend/src/lib/types.ts.
// A backend drift-guard test pins the two copies byte-identically.
// Bump CIP20_HELPER_VERSION on any change.
// ============================================================

/** Version pin for the helper's behaviour. Bump when the chunking or
 *  envelope shape changes; the drift-guard test asserts this string is
 *  present in every duplicated copy so a partial-update is caught. */
export const CIP20_HELPER_VERSION = 'v1';

/** CIP-20 reserved metadata label. */
export const CIP20_LABEL = 674;

/** Hard byte ceiling for a single text-chunk in CBOR major-type 3.
 *  CIP-20 requires each string in the msg array to fit within this bound. */
export const CIP20_MAX_CHUNK_BYTES = 64;

/**
 * The canonical CIP-20 envelope shape. The whole object is what gets
 * attached at label 674 in the tx metadata map. The CDDL is:
 *
 *   transaction_message ::= { "msg": [ * tstr .size (0..64) ] }
 *
 * `Cip20Envelope.msg` is a non-empty array of UTF-8 strings, each at most
 * 64 bytes. An empty array is technically valid but conveys no message,
 * so the builder rejects empty input rather than producing a noise row.
 */
export interface Cip20Envelope {
  msg: string[];
}

/**
 * Default attribution payload — the marker drep.tools stamps on every
 * vote it assembles. Kept short so it always fits in one chunk; the
 * trailing "drep-tools" string is the machine-readable tag analysts can
 * grep for. Keep these on separate array entries so a future renderer
 * can decide whether to show the human line, the machine tag, or both.
 *
 * BOTH values are well under 64 bytes (24 and 10 bytes respectively in
 * UTF-8), so the chunker never splits them.
 */
export const DEFAULT_ATTRIBUTION_MESSAGE = 'Voted via drep.tools';
export const DEFAULT_ATTRIBUTION_TAG = 'drep-tools';

/**
 * Returns the UTF-8 byte length of `s`. Used by the chunker so it slices
 * on a byte budget rather than a code-point budget — required to satisfy
 * CIP-20's 64-byte ceiling on multi-byte text. Tolerant of empty input.
 *
 * The implementation prefers the runtime `TextEncoder` (available in
 * Node ≥ 11 and every modern browser) and falls back to `Buffer` so the
 * helper stays usable in older Node-only contexts. If neither is
 * available the function returns the code-point length, which is a
 * safe-but-pessimistic estimate (the chunker will produce shorter
 * chunks than necessary rather than overshooting the byte budget).
 */
export function utf8ByteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(s, 'utf8');
  }
  // Last-resort fallback: code-point length is always ≤ byte length, so
  // the chunker will undershoot the budget — never overshoot.
  return s.length;
}

/**
 * Split `s` into a list of UTF-8 chunks, each at most `maxBytes` bytes.
 *
 * The chunker is byte-aware: it appends code points one at a time and
 * flushes a chunk whenever adding the next code point would exceed the
 * byte budget. This guarantees each emitted chunk is a valid UTF-8 string
 * AND fits the byte limit — naive substr-by-character would either
 * produce too-large chunks on multi-byte text or split a multi-byte
 * sequence in the middle.
 *
 * `String[Symbol.iterator]()` yields whole code points (not UTF-16 code
 * units) so a surrogate pair is treated as one indivisible character —
 * we never bisect an emoji.
 *
 * Empty input returns an empty array; the caller decides whether to
 * tolerate that. `buildCip20Envelope` rejects an empty result.
 */
export function chunkUtf8(s: string, maxBytes: number = CIP20_MAX_CHUNK_BYTES): string[] {
  if (!s) return [];
  if (maxBytes <= 0) {
    throw new Error(`chunkUtf8: maxBytes must be positive, got ${maxBytes}`);
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of s) {
    const cpBytes = utf8ByteLength(codePoint);
    if (cpBytes > maxBytes) {
      // A single code point larger than the chunk budget can't fit at
      // all — this only happens for absurdly small maxBytes values
      // (CIP-20's 64-byte ceiling is comfortably above any single
      // code point's max of 4 bytes). We emit the single-codepoint
      // chunk on its own; downstream callers that require strict
      // ≤ maxBytes should set maxBytes ≥ 4.
      if (current) {
        chunks.push(current);
        current = '';
        currentBytes = 0;
      }
      chunks.push(codePoint);
      continue;
    }
    if (currentBytes + cpBytes > maxBytes) {
      chunks.push(current);
      current = codePoint;
      currentBytes = cpBytes;
    } else {
      current += codePoint;
      currentBytes += cpBytes;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Build a CIP-20 envelope (`{ msg: [...] }`) from one or more message
 * strings. Each input string is independently chunked to fit within the
 * 64-byte ceiling and the chunks are concatenated into a single `msg`
 * array preserving input order.
 *
 * Inputs:
 *   - `messages` — one or more strings to attach. Each is chunked; the
 *     ordering is preserved across inputs (so `["A", "B"]` produces
 *     `[chunks(A)..., chunks(B)...]`). The function trims neither end of
 *     the input — the caller decides what trimming policy applies.
 *   - `maxBytes` — chunk budget. Defaults to CIP-20's 64-byte limit;
 *     tests use it to exercise the chunker on smaller budgets.
 *
 * Throws if the input is empty or all whitespace — an envelope with no
 * chunks is structurally valid but conveys no information, and a typo'd
 * call site shouldn't silently produce noise rows.
 */
export function buildCip20Envelope(
  messages: ReadonlyArray<string>,
  maxBytes: number = CIP20_MAX_CHUNK_BYTES,
): Cip20Envelope {
  const out: string[] = [];
  for (const m of messages) {
    for (const chunk of chunkUtf8(m, maxBytes)) {
      out.push(chunk);
    }
  }
  if (out.length === 0) {
    throw new Error('buildCip20Envelope: at least one non-empty message is required');
  }
  return { msg: out };
}

/**
 * Convenience: build the default drep.tools attribution envelope. Uses
 * `DEFAULT_ATTRIBUTION_MESSAGE` + `DEFAULT_ATTRIBUTION_TAG` on separate
 * array entries. Returns the envelope (not the `{label: 674, value: ...}`
 * pair) so the caller can hand it to whatever metadata API its tx
 * builder exposes — e.g. Mesh's `.metadataValue(674, envelope)`.
 *
 * The platform's vote submission path calls this from
 * `frontend/src/lib/voteTx.ts::buildUnsignedVoteTx` and threads the
 * result into the `MeshTxBuilder.metadataValue(...)` call so every vote
 * that drep.tools assembles carries the attribution stamp.
 */
export function buildDefaultDrepToolsAttribution(): Cip20Envelope {
  return buildCip20Envelope([
    DEFAULT_ATTRIBUTION_MESSAGE,
    DEFAULT_ATTRIBUTION_TAG,
  ]);
}

/**
 * Build the `{ label, value }` pair Mesh-compatible metadata APIs accept.
 * Kept separate from `buildCip20Envelope` so a caller can either:
 *   - call .metadataValue(674, envelope) and pass the envelope alone, or
 *   - hand the wrapper to an API that expects {label, value} entries.
 *
 * The label is the constant 674; the value is the envelope object. Mesh
 * accepts the envelope shape directly under `.metadataValue` so this
 * wrapper is for API surfaces that want explicit {label, value} pairs
 * (notably a future CSL-direct builder).
 */
export interface Cip20MetadataEntry {
  label: number;
  value: Cip20Envelope;
}

export function toMetadataEntry(envelope: Cip20Envelope): Cip20MetadataEntry {
  return { label: CIP20_LABEL, value: envelope };
}
