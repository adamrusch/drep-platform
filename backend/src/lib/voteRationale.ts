/**
 * Vote-rationale fetch + extract.
 *
 * A governance voter (DRep / SPO / CC member) MAY attach a CIP-100 rationale
 * anchor to their vote: an off-chain JSON document referenced by a URL
 * (usually `ipfs://CID`, sometimes `https://…`) plus a blake2b-256 hash of
 * its body. The governance-intake sync stores that URL + hash on the
 * `governance_votes` row (`metaUrl` / `metaHash`) but does NOT download the
 * body — so the UI could only render a raw external link.
 *
 * This module downloads the body (reusing the multi-gateway IPFS fetcher with
 * on-chain-hash verification), parses the CIP-100/108 shape, and extracts a
 * compact, display-ready { title, text } so the platform can show the
 * rationale inline and cache it in DynamoDB. The `vote-rationale-sync` Lambda
 * is the caller; everything here is pure-ish (one network read) and unit
 * tested without AWS.
 *
 * CIP shapes handled:
 *   - CIP-100 (the canonical vote-rationale shape): `body.comment` is the
 *     voter's free-text rationale.
 *   - CIP-108 (governance-action metadata, but some voters reuse it): we also
 *     accept `body.rationale` / `body.abstract` / `body.motivation` via the
 *     shared `parseCip108Body`.
 *   - A bare object with the fields at the top level (no `body` wrapper).
 */
import blake2b from 'blake2b';
import { extractIpfsCid, fetchIpfsAnchor } from './ipfsGateway';
import { parseCip108Body } from './cip108';

/** Max bytes we'll pull from a non-IPFS https anchor (matches the IPFS cap). */
const MAX_BODY_BYTES = 256 * 1024;
/** Hard per-fetch timeout for a direct https anchor read. */
const HTTPS_TIMEOUT_MS = 8_000;
/** Cap on the stored rationale text. Vote rationales are usually a paragraph;
 *  a runaway body is truncated so a single DDB item stays well under 400 KB
 *  and the votes query payload stays lean. */
const MAX_TEXT_LEN = 12_000;
const USER_AGENT = 'drep-platform-rationale-sync/1.0';

/**
 * Outcome of trying to cache one vote's rationale:
 *   - `cached`        — body fetched, parsed, text extracted (hash verified or
 *                       no hash to check).
 *   - `hash_mismatch` — body fetched but its blake2b-256 != on-chain metaHash.
 *                       We still surface the text (it's what the URL served)
 *                       but the UI flags it as unverified.
 *   - `empty`         — body fetched + parsed but contained no usable text.
 *   - `unreachable`   — no gateway / host returned the body (retryable later).
 *   - `unsupported`   — the anchor URL isn't a scheme we fetch (ipfs/https), or
 *                       an IPFS anchor lacked a verifiable hash.
 */
export type VoteRationaleStatus =
  | 'cached'
  | 'hash_mismatch'
  | 'empty'
  | 'unreachable'
  | 'unsupported';

export interface VoteRationaleResult {
  status: VoteRationaleStatus;
  /** CIP-108 `body.title`, when present. */
  title?: string;
  /** The voter's rationale text (CIP-100 `comment`, else rationale/abstract/
   *  motivation), truncated to MAX_TEXT_LEN. */
  text?: string;
  /** True when `text` was truncated to fit MAX_TEXT_LEN. */
  truncated?: boolean;
  /** true = body matched on-chain hash; false = mismatch; undefined = no hash
   *  to verify against (a bare https anchor with no metaHash). */
  hashMatch?: boolean;
  /** The gateway / URL that produced the body (provenance / debugging). */
  source?: string;
}

function blake2b256Hex(buf: Buffer): string {
  const out = Buffer.alloc(32);
  blake2b(32).update(buf).digest(out);
  return out.toString('hex');
}

function truncate(s: string): { text: string; truncated: boolean } {
  const t = s.trim();
  if (t.length <= MAX_TEXT_LEN) return { text: t, truncated: false };
  return { text: t.slice(0, MAX_TEXT_LEN), truncated: true };
}

/**
 * Pull the display-ready { title, text } out of a parsed CIP-100/108 JSON
 * body. Pure — no I/O. Exported for unit testing.
 *
 * Preference order for the text: CIP-100 `comment` (the canonical vote-
 * rationale field) → CIP-108 `rationale` → `abstract` → `motivation`.
 */
export function extractVoteRationale(
  json: unknown,
): { title?: string; text?: string; truncated?: boolean } {
  if (!json || typeof json !== 'object') return {};
  const root = json as Record<string, unknown>;
  // `parseCip108Body` already handles the `body` wrapper + title/abstract/
  // motivation/rationale (and truncates long fields). It does NOT know the
  // CIP-100 `comment` field, so we read that ourselves from the same body.
  const cip108 = parseCip108Body(root);
  const bodyRaw = (root['body'] ?? root) as unknown;
  const body =
    bodyRaw && typeof bodyRaw === 'object' ? (bodyRaw as Record<string, unknown>) : {};
  const comment = typeof body['comment'] === 'string' ? body['comment'].trim() : '';

  const chosen =
    comment ||
    cip108.rationale ||
    cip108.abstract ||
    cip108.motivation ||
    '';

  const out: { title?: string; text?: string; truncated?: boolean } = {};
  if (cip108.title) out.title = cip108.title;
  if (chosen) {
    const { text, truncated } = truncate(chosen);
    out.text = text;
    if (truncated) out.truncated = true;
  }
  return out;
}

/** Direct https(s) anchor read with a timeout + byte cap. Never throws —
 *  returns the raw bytes or null. Only http/https schemes are attempted. */
async function fetchHttpsBody(url: string): Promise<Buffer | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTPS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.byteLength > MAX_BODY_BYTES) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(body: string): unknown | null {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * Fetch + verify + extract one vote's rationale.
 *
 * @param metaUrl  the vote's `metaUrl` (ipfs:// or https://)
 * @param metaHash the vote's `metaHash` (blake2b-256 hex), if any
 *
 * Resolution:
 *   1. IPFS anchor → reuse `fetchIpfsAnchor` (multi-gateway + hash verify).
 *      Requires a valid 64-hex hash; without one we can't verify and return
 *      `unsupported`.
 *   2. https anchor → direct read; verify against metaHash when present.
 *   3. anything else (data:, ar://, …) → `unsupported`.
 *
 * Never throws.
 */
export async function fetchVoteRationale(
  metaUrl: string | undefined,
  metaHash: string | undefined,
): Promise<VoteRationaleResult> {
  const url = (metaUrl ?? '').trim();
  if (!url) return { status: 'empty' };

  const hash = (metaHash ?? '').toLowerCase().trim();
  const hasValidHash = /^[0-9a-f]{64}$/.test(hash);

  let body: string | null = null;
  let hashMatch: boolean | undefined;
  let source: string | undefined;

  const cid = extractIpfsCid(url);
  if (cid) {
    // The IPFS fetcher REQUIRES a verifiable hash (it compares every gateway
    // body against it). An IPFS anchor with no/garbage hash can't be trusted.
    if (!hasValidHash) return { status: 'unsupported' };
    const res = await fetchIpfsAnchor(cid, hash);
    if (!res) return { status: 'unreachable' };
    body = res.body;
    hashMatch = res.hashMatch;
    source = res.gatewayUsed;
  } else if (/^https?:\/\//i.test(url)) {
    const bytes = await fetchHttpsBody(url);
    if (!bytes) return { status: 'unreachable' };
    body = bytes.toString('utf-8');
    source = url;
    if (hasValidHash) hashMatch = blake2b256Hex(bytes) === hash;
  } else {
    return { status: 'unsupported' };
  }

  const json = parseBody(body);
  if (json === null) {
    // Body fetched but not JSON — nothing displayable.
    return { status: hashMatch === false ? 'hash_mismatch' : 'empty', ...(source ? { source } : {}) };
  }

  const ext = extractVoteRationale(json);
  if (!ext.title && !ext.text) {
    return { status: hashMatch === false ? 'hash_mismatch' : 'empty', ...(source ? { source } : {}) };
  }

  return {
    status: hashMatch === false ? 'hash_mismatch' : 'cached',
    ...(ext.title ? { title: ext.title } : {}),
    ...(ext.text ? { text: ext.text } : {}),
    ...(ext.truncated ? { truncated: true } : {}),
    ...(hashMatch !== undefined ? { hashMatch } : {}),
    ...(source ? { source } : {}),
  };
}
