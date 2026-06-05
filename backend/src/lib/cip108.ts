/**
 * CIP-108 / CIP-100 metadata-body extraction.
 *
 * Pure, dependency-light parsing of a governance anchor body (the off-chain
 * JSON referenced by a governance action OR a vote). Kept in its own module —
 * separate from `blockfrost.ts` — so lean consumers (e.g. the vote-rationale
 * sync Lambda) can import the parser WITHOUT dragging in the Blockfrost SDK
 * and the Cardano serialization-lib WASM that `blockfrost.ts`'s wider import
 * graph pulls in. `blockfrost.ts` re-exports these for backwards compat.
 */
import type { GovernanceReference } from './types';

export interface ParsedCip108 {
  title?: string;
  abstract?: string;
  motivation?: string;
  rationale?: string;
  references?: GovernanceReference[];
}

/**
 * Per-field cap on body text we store in DynamoDB. Real-world anchors range
 * from a few KB to a few MB (some embed full HTML/markdown reports inline).
 * DynamoDB items are capped at 400KB total, so writing an unbounded body
 * field — especially when there are several of them — will fail with a
 * `ValidationException: Item size has exceeded the maximum allowed size`.
 *
 * 60KB per field gives plenty of room for prose (60K UTF-8 ≈ 30+ pages of
 * text) while leaving comfortable headroom: 4 fields × 60KB + references
 * + on-chain summary + envelope ≈ 250KB worst case, well under the limit.
 *
 * When a field is truncated we append a marker pointing the reader at the
 * canonical anchor URL — the full body remains accessible off-chain.
 */
const BODY_FIELD_MAX_BYTES = 60_000;
const TRUNCATION_MARKER = '\n\n…[truncated for storage; full text at the anchor URL]';

function truncateField(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  // Use byte length, not char count: DDB's limit is bytes, and CIP-108 bodies
  // commonly contain UTF-8 with multi-byte runes (em-dashes, accents, emoji).
  const bytes = Buffer.byteLength(trimmed, 'utf-8');
  if (bytes <= BODY_FIELD_MAX_BYTES) return trimmed;
  // Slice by chars first, then iteratively trim until the byte budget fits.
  // Char-budget heuristic gets us close on first attempt; we refine after.
  let charBudget = Math.floor(BODY_FIELD_MAX_BYTES * (trimmed.length / bytes));
  let candidate = trimmed.slice(0, charBudget);
  while (Buffer.byteLength(candidate + TRUNCATION_MARKER, 'utf-8') > BODY_FIELD_MAX_BYTES) {
    charBudget = Math.floor(charBudget * 0.95);
    candidate = trimmed.slice(0, charBudget);
    if (charBudget <= 0) {
      candidate = '';
      break;
    }
  }
  return candidate + TRUNCATION_MARKER;
}

export function parseCip108Body(json: Record<string, unknown> | null): ParsedCip108 {
  if (!json) return {};
  // CIP-108 wraps the user-readable content under `body`.
  const bodyRaw = (json['body'] ?? json) as unknown;
  if (!bodyRaw || typeof bodyRaw !== 'object') return {};
  const body = bodyRaw as Record<string, unknown>;
  const result: ParsedCip108 = {};
  if (typeof body['title'] === 'string') {
    // Titles never need truncation — DDB can hold a 1KB title without issue.
    result.title = body['title'].trim();
  }
  if (typeof body['abstract'] === 'string') {
    result.abstract = truncateField(body['abstract']);
  }
  if (typeof body['motivation'] === 'string') {
    result.motivation = truncateField(body['motivation']);
  }
  if (typeof body['rationale'] === 'string') {
    result.rationale = truncateField(body['rationale']);
  }
  const refsRaw = body['references'];
  if (Array.isArray(refsRaw)) {
    const refs: GovernanceReference[] = [];
    for (const r of refsRaw) {
      if (!r || typeof r !== 'object') continue;
      const ref = r as Record<string, unknown>;
      const uri = typeof ref['uri'] === 'string' ? ref['uri'].trim() : '';
      const label = typeof ref['label'] === 'string' ? ref['label'].trim() : uri;
      if (uri.length === 0) continue;
      refs.push({ label: label || uri, uri });
    }
    if (refs.length > 0) result.references = refs;
  }
  return result;
}
