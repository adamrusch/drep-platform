// =============================================================================
// IPFS multi-gateway anchor fetcher with blake2b-256 hash verification.
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Cardano governance actions reference their off-chain metadata via an
// `anchor` — a {url, hash} pair where the URL points to a CIP-100/108 JSON
// body and the hash is the blake2b-256 of that body's raw bytes. The URL is
// typically `ipfs://CID` (per CIP-100 §Spec), but wallets sometimes write
// pre-resolved gateway URLs (`https://x.ipfs.gateway/ipfs/CID`).
//
// Koios — our primary metadata source — runs its own IPFS node and proxies
// anchor fetches through it. When the network has trouble routing to the
// specific CID (peer offline, content not pinned widely, gateway DNS gone)
// Koios returns `meta_json: null` even though the on-chain anchor exists.
// As of 2026-05, this happens for ~7 of ~313 mainnet governance actions.
//
// The fix is to try several PUBLIC IPFS gateways ourselves, fall back through
// the list until one returns a body whose blake2b-256 hash matches the
// on-chain `meta_hash`, and store the recovered body in our own row.
//
// WHY MULTIPLE GATEWAYS
// ---------------------
// IPFS gateways differ in:
//   - which peers they're connected to (and thus which CIDs they can route);
//   - DNS health (cloudflare-ipfs.com went dark in 2024);
//   - rate limits and timeout policies;
//   - whether they require subdomain-style URLs (`<cid>.ipfs.dweb.link`).
// No single gateway is universally reliable. By trying several in series we
// trade a bit of latency for a much higher recovery rate.
//
// SECURITY MODEL
// --------------
// The on-chain `meta_hash` is the trust anchor. We treat every gateway as
// UNTRUSTED — a gateway could return arbitrary bytes — and only accept a
// response whose blake2b-256 matches the expected hex. A mismatch silently
// falls through to the next gateway; a body that no gateway can match is
// reported as a recovery failure (the row stays in `metadataSource: 'none'`).
// This means a malicious gateway cannot poison our metadata; the worst it
// can do is fail the lookup, which Koios is already doing.
//
// RATE-LIMIT CONSIDERATIONS
// -------------------------
// Public IPFS gateways are best-effort and free. To avoid being a bad
// neighbor:
//   - Per-gateway timeout is short (5s) — we don't tie up gateway sockets.
//   - Per-response byte cap is 1 MiB — protects us AND limits gateway egress.
//   - Sequential, not parallel — one successful fetch is enough; fanning out
//     hits every gateway for the same content even when one would suffice.
//   - Caller-side, we only re-attempt a failed CID once every 24 hours
//     (gated by `ENRICHMENT_TTL_MS` in the sync). So a permanently-lost CID
//     produces 6 gateway hits per day, not 6 per minute.
//   - We send a stable User-Agent identifying the project so gateway
//     operators can rate-limit us specifically if needed.
//
// =============================================================================

import blake2b from 'blake2b';

const PER_GATEWAY_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_024 * 1_024; // 1 MiB
const USER_AGENT = 'drep-platform/1.0 (https://drep.tools)';

/**
 * Public IPFS gateways, tried in order. Ordering matters:
 *   1. `ipfs.io`           — Protocol Labs canonical; widest peer coverage.
 *   2. `gateway.pinata.cloud` — Stable; serves content pinned by Pinata
 *      customers (most governance proposers pin via Pinata).
 *   3. `dweb.link`         — Protocol Labs subdomain gateway; redirects
 *      `ipfs/{cid}` → `{cid}.ipfs.dweb.link`. We follow redirects.
 *   4. `nftstorage.link`   — Subdomain-style, similar to dweb.link.
 *   5. `w3s.link`          — Web3.Storage; also subdomain-style.
 *
 * Cloudflare's `cloudflare-ipfs.com` was DEPRECATED in 2024 and now returns
 * DNS NXDOMAIN — deliberately omitted from the list.
 */
const PUBLIC_GATEWAYS: readonly string[] = [
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://w3s.link/ipfs/',
];

export interface IpfsFetchResult {
  /** Raw bytes of the content (UTF-8 string for typical CIP-108 bodies). */
  body: string;
  /** Which gateway URL produced the body (full URL including CID). */
  gatewayUsed: string;
  /** Computed blake2b-256 hex of the body (lowercase, 64 chars). */
  computedHash: string;
}

/**
 * Parse an anchor URL into a CID. Accepts:
 *   - `ipfs://CID`                      (most common, CIP-100 §Spec)
 *   - `ipfs://ipfs/CID`                 (some wallet implementations)
 *   - `https://*.ipfs.gateway/ipfs/CID` (pre-resolved gateway URL — happens
 *     when a wallet hardcodes a private gateway like quicknode-ipfs.com)
 *   - `https://*.ipfs.gateway/CID`      (subdomain-less variant)
 *
 * Returns null if the URL doesn't look like an IPFS anchor (e.g. a raw
 * GitHub link, an https URL without an `/ipfs/CID` segment).
 *
 * Does NOT validate that the CID is well-formed beyond a coarse character
 * check (alphanumeric + the IPFS multibase set). A malformed CID will fall
 * through to the gateway, which will 4xx, which we treat as a normal failure.
 */
export function extractIpfsCid(anchorUrl: string): string | null {
  if (!anchorUrl || typeof anchorUrl !== 'string') return null;
  const trimmed = anchorUrl.trim();
  if (trimmed.length === 0) return null;

  // ipfs://CID or ipfs://ipfs/CID
  const ipfsMatch = trimmed.match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)/);
  if (ipfsMatch && ipfsMatch[1]) return validateCidLike(ipfsMatch[1]);

  // https://anything/ipfs/CID  (path-style gateway URL)
  const pathMatch = trimmed.match(/^https?:\/\/[^/]+\/ipfs\/([A-Za-z0-9]+)/i);
  if (pathMatch && pathMatch[1]) return validateCidLike(pathMatch[1]);

  // https://CID.ipfs.anything/  (subdomain-style gateway URL)
  const subdomainMatch = trimmed.match(/^https?:\/\/([A-Za-z0-9]+)\.ipfs\./i);
  if (subdomainMatch && subdomainMatch[1]) return validateCidLike(subdomainMatch[1]);

  return null;
}

/**
 * Cheap CID sanity check: CIDv0 starts with `Qm` and is 46 chars; CIDv1
 * starts with `b`/`z`/`f` and is typically 50–62 chars in base32. Anything
 * shorter than 30 chars is almost certainly not a CID — reject early to
 * avoid sending obvious garbage to the gateways.
 */
function validateCidLike(s: string): string | null {
  if (s.length < 30 || s.length > 100) return null;
  return s;
}

/**
 * Compute blake2b-256 of a buffer as lowercase hex. Mirrors the helper in
 * `blockfrost.ts` (kept private there); we duplicate it here rather than
 * importing to keep this module self-contained and easier to unit-test.
 */
function blake2b256Hex(buf: Buffer): string {
  const out = Buffer.alloc(32);
  blake2b(32).update(buf).digest(out);
  return out.toString('hex');
}

/**
 * Fetch one gateway with a hard timeout and a streaming byte cap. Returns
 * the body bytes on 2xx-with-payload, null on any failure (network, non-2xx,
 * body-too-large, timeout). Never throws.
 */
async function fetchOneGateway(url: string): Promise<Buffer | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PER_GATEWAY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      // Follow redirects — dweb.link / nftstorage.link / w3s.link issue 301s
      // to the subdomain-style URL on the first hop.
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, application/octet-stream, */*',
      },
    });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) {
      // Fallback: synchronous text read with size check.
      const text = await res.text();
      const buf = Buffer.from(text, 'utf-8');
      if (buf.byteLength > MAX_BODY_BYTES) return null;
      return buf;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {
          /* swallow */
        });
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch {
    // Network error, abort (timeout), DNS failure — all collapse to null.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try a list of public IPFS gateways in series. Returns the first successful
 * fetch whose blake2b-256 hash matches `expectedHashHex`. Returns null if
 * every gateway fails or none produces a hash match.
 *
 * Hash comparison is case-insensitive. The on-chain hash is canonically
 * lowercase hex but we coerce both sides to lowercase to be defensive.
 *
 * NEVER throws — all errors collapse to a null return so the caller can
 * treat a failed recovery as a normal "no metadata" state.
 */
export async function fetchIpfsAnchor(
  cid: string,
  expectedHashHex: string,
): Promise<IpfsFetchResult | null> {
  if (!cid || typeof cid !== 'string') return null;
  if (!expectedHashHex || typeof expectedHashHex !== 'string') return null;
  const expected = expectedHashHex.toLowerCase().trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    // Not a well-formed blake2b-256 hex string — refuse to attempt, since
    // we can't verify the response anyway.
    return null;
  }

  for (const prefix of PUBLIC_GATEWAYS) {
    const gatewayUrl = `${prefix}${cid}`;
    const bytes = await fetchOneGateway(gatewayUrl);
    if (!bytes) continue;
    let computed: string;
    try {
      computed = blake2b256Hex(bytes);
    } catch {
      // A blake2b binding failure shouldn't happen in practice, but we
      // never want it to kill the loop — skip to the next gateway.
      continue;
    }
    if (computed !== expected) {
      // Wrong content; gateway might be serving a stale or substituted
      // copy. Fall through to the next gateway rather than trusting it.
      continue;
    }
    return {
      body: bytes.toString('utf-8'),
      gatewayUsed: gatewayUrl,
      computedHash: computed,
    };
  }
  return null;
}
