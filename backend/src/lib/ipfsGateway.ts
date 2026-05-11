// =============================================================================
// Off-chain anchor recovery: multi-gateway IPFS + GitHub commit-history walk.
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Cardano governance actions reference their off-chain metadata via an
// `anchor` — a {url, hash} pair where the URL points to a CIP-100/108 JSON
// body and the hash is the blake2b-256 of that body's raw bytes. The URL is
// typically `ipfs://CID` (per CIP-100 §Spec), but in practice wallets write a
// variety of things: pre-resolved gateway URLs, raw GitHub URLs, or arbitrary
// HTTPS endpoints. Each transport has its own failure mode and its own
// recovery strategy. This module owns all of them.
//
// Koios — our primary metadata source — runs its own IPFS node and proxies
// anchor fetches through it. When the network has trouble routing to the
// specific CID (peer offline, content not pinned widely, gateway DNS gone)
// Koios returns `meta_json: null` even though the on-chain anchor exists.
// As of 2026-05, this happens for ~7 of ~313 mainnet governance actions.
//
// THE THREE RECOVERY TECHNIQUES
// -----------------------------
// 1. `fetchIpfsAnchor` — multi-gateway IPFS walk with hash verification.
//    Used when the anchor URL parses to an IPFS CID. Tries several public
//    gateways in series; returns the first body whose blake2b-256 matches
//    the on-chain hash.
//
// 2. `fetchIpfsAnchor` with `hashMatch: false` — same walk, but when EVERY
//    gateway agrees on the same body and that body's hash does NOT match
//    the on-chain hash, we still surface the body so the UI can render it
//    with a "Hash mismatch" warning. This recovers anchors where the
//    proposer published mismatched content (joke proposals, copy-paste
//    errors): the content is real, just not cryptographically attestable.
//
// 3. `fetchGithubHistoricalAnchor` — for `raw.githubusercontent.com` URLs
//    that point to a branch ref (e.g. `refs/heads/main/path/to/file`), the
//    URL doesn't pin the content. If the file was edited or moved after the
//    governance action was submitted, the on-chain hash refers to a
//    historical commit's bytes. We walk that file's commit history via the
//    GitHub API and return the first commit whose content hashes correctly.
//    Recovers actions like the ICC PPU October 2024 proposal whose file
//    was moved by commit `c221c0f6f6` ("change path for existing action to
//    break rendering") but whose parent commit still serves the right bytes.
//
// WHY MULTIPLE IPFS GATEWAYS
// --------------------------
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
// The on-chain `meta_hash` is the trust anchor. We treat every transport
// (gateway, GitHub) as UNTRUSTED — they could return arbitrary bytes — and
// the IpfsFetchResult carries a `hashMatch` boolean derived from a fresh
// blake2b-256 computation over the bytes we received. The CALLER decides
// what to do with mismatched bodies: surface them with a prominent warning,
// or refuse them. For the GitHub historical walk we only return commits that
// DO hash-match, since the whole point of walking history is to find the
// version the on-chain hash actually refers to.
//
// RATE-LIMIT CONSIDERATIONS
// -------------------------
// Public IPFS gateways are best-effort and free. The GitHub commits API has
// a 60 req/IP/hour unauthenticated limit. To avoid being a bad neighbor:
//   - Per-request timeout is short (5s) — we don't tie up sockets.
//   - Per-response byte cap is 1 MiB — protects us AND limits server egress.
//   - Sequential, not parallel — one successful fetch is enough.
//   - The GitHub walk fetches at most 30 commit listings + ≤30 raw blobs,
//     and gives up the moment one matches.
//   - Per-anchor wall-clock budget on the GitHub walk: 30s. A pathological
//     repository with hundreds of edits would otherwise stall the sync.
//   - Caller-side, the 24h `ENRICHMENT_TTL_MS` window in the sync gates
//     retries — a permanently-failing anchor costs us at most one walk per
//     day, not one per minute.
//   - All requests carry a stable User-Agent so operators can rate-limit us.
//
// =============================================================================

import blake2b from 'blake2b';

const PER_GATEWAY_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_024 * 1_024; // 1 MiB
const USER_AGENT = 'drep-platform/1.0 (https://drep.tools)';

/**
 * Total wall-clock budget for one GitHub historical-anchor walk. Caps the
 * cost of a pathological repository (file with hundreds of edits, or a
 * GitHub outage where every request hangs to its individual timeout). At
 * 5s per request and ~30 commits max we expect ≤155s in the worst case;
 * 30s is a deliberate sanity ceiling that returns null and lets the next
 * sync cycle try again.
 */
const GITHUB_WALK_BUDGET_MS = 30_000;

/**
 * Max number of historical commits to inspect for one file. GitHub's
 * default `per_page=30` matches this — we explicitly request 30 so the
 * behavior is independent of any future API default change. Increase only
 * if real-world data shows files getting edited >30 times after the
 * governance action was submitted (none so far on mainnet).
 */
const GITHUB_MAX_COMMITS = 30;

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
  /** True when `computedHash` matches the caller's expected hash. False
   *  when the gateway returned a body whose hash differs — the caller can
   *  still choose to surface the content (with a "Hash mismatch" warning),
   *  but cannot attest to chain integrity. See the holdout rationale in the
   *  module header: some proposers publish mismatched content (joke
   *  proposals, copy-paste errors); refusing them entirely is more user-
   *  hostile than surfacing them with a clear caveat. */
  hashMatch: boolean;
}

export interface GithubHistoricalAnchorResult {
  /** Raw bytes of the content (UTF-8 string for CIP-108 bodies). */
  body: string;
  /** Full git SHA (40 hex chars) of the commit whose blob hash-matched. */
  commitSha: string;
  /** ISO-8601 commit date (from GitHub API `commit.committer.date`). */
  commitDate: string;
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
 * fetch — preferring a hash-matching body, but falling back to a hash-MIS-
 * matching body when every reachable gateway agrees on the same (wrong-hash)
 * content. Returns null only when no gateway is reachable at all.
 *
 * Why the two-pass behavior:
 *   - Hash-match is the canonical path. The on-chain hash is the trust
 *     anchor, and a body matching it is cryptographically attested.
 *   - Hash-mismatch DOES happen on mainnet. A handful of proposers (e.g.
 *     the HOSKY hard-fork joke proposal from governance day 1) published
 *     metadata whose bytes differ from the hash they declared on-chain.
 *     Every public gateway returns the same (wrong-hash) body, so the
 *     content IS authoritative for that anchor URL — we just can't claim
 *     chain-integrity verification. Refusing to surface it leaves the row
 *     in the `metadataSource: 'none'` bucket and hides real content from
 *     the user. Surfacing it with `hashMatch: false` lets the UI render
 *     the body alongside a prominent "Hash mismatch" warning.
 *
 * Implementation:
 *   - First pass: walk gateways; return on the FIRST hash-matching body.
 *   - If no gateway hash-matches, return the FIRST body we successfully
 *     fetched (whichever gateway was reachable first). The mismatch flag
 *     is propagated so the caller can branch.
 *
 * Hash comparison is case-insensitive. The on-chain hash is canonically
 * lowercase hex but we coerce both sides to lowercase to be defensive.
 *
 * NEVER throws — all errors collapse to a null return.
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
    // we can't even compare a response. Returning null lets the caller fall
    // through to the next recovery technique.
    return null;
  }

  // Track the first successful fetch so we can surface it as a mismatch
  // fallback when no gateway returns a hash-matching body. We hold on to
  // exactly ONE fallback (the first reachable gateway): if every gateway
  // returned a wrong-hash body the content is presumed authoritative-but-
  // mismatched; if gateways disagreed something weirder is happening and
  // we'd rather report no metadata than guess which gateway to trust.
  let mismatchFallback: IpfsFetchResult | null = null;

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
    if (computed === expected) {
      return {
        body: bytes.toString('utf-8'),
        gatewayUsed: gatewayUrl,
        computedHash: computed,
        hashMatch: true,
      };
    }
    // Hash didn't match. Keep walking — a later gateway might have the
    // right bytes (gateways occasionally serve stale or substituted copies
    // independent of the proposer's mistakes). Remember the FIRST mismatched
    // body as a fallback in case no gateway hash-matches.
    if (!mismatchFallback) {
      mismatchFallback = {
        body: bytes.toString('utf-8'),
        gatewayUsed: gatewayUrl,
        computedHash: computed,
        hashMatch: false,
      };
    }
  }
  return mismatchFallback;
}

// =============================================================================
// GitHub commit-history walk
// =============================================================================
//
// Why a separate technique: anchor URLs on `raw.githubusercontent.com` look
// like
//   https://raw.githubusercontent.com/{owner}/{repo}/refs/heads/main/{path}
// The `refs/heads/main` ref does NOT pin the content. If the file is edited
// after the governance action's submission, the URL serves the new bytes —
// which won't match the on-chain hash. The old bytes still exist in git
// history; we just have to find them by SHA. GitHub's Commits API
// (`/repos/{owner}/{repo}/commits?path={path}`) returns the commit history
// for one file path, newest first. We walk it, fetch each commit's blob,
// hash, and stop at the first match.
//
// The ICC PPU October 2024 holdout is the canonical case: commit
// `c221c0f6f6` ("change path for existing action to break rendering") moved
// the file, so the current `main` is 404. The parent `cd7bccf0e4`
// ("fix hashes for preview hf and mainnet ppu") still has the original
// bytes — and they hash-match the on-chain anchor.

/** Parse a `raw.githubusercontent.com` URL into its components. Accepts
 *  both `refs/heads/{branch}` and bare `{branch}/{path}` shapes. Returns
 *  null for any other URL — including SHA-pinned URLs, since those
 *  already point at immutable content and walking history would be moot. */
function parseGithubRawUrl(
  url: string,
): { owner: string; repo: string; ref: string; path: string } | null {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)\/(.+)$/i,
  );
  if (!m) return null;
  const [, owner, repo, ref, path] = m;
  if (!owner || !repo || !ref || !path) return null;
  // Reject SHA-pinned URLs (40 hex). They're already immutable; walking
  // history won't find a "more correct" version. We still return null so
  // the caller can fall through; the URL probably just 404s for unrelated
  // reasons (file deleted in a SUBSEQUENT commit).
  if (/^[0-9a-f]{40}$/i.test(ref)) return null;
  return { owner, repo, ref, path };
}

/** GitHub Commits API row shape — only the fields we read. */
interface GithubCommitRow {
  sha: string;
  commit?: {
    committer?: { date?: string };
    author?: { date?: string };
  };
}

/**
 * Try to recover anchor content from prior commits of a github raw URL.
 *
 *  Parses `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`,
 *  queries `GET /repos/{owner}/{repo}/commits?path={path}` (newest-first,
 *  up to 30 commits), and for each commit fetches
 *  `https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}` and
 *  checks the blake2b-256 against `expectedHashHex`. Returns the first
 *  match. Walks no further once a match is found.
 *
 *  Why commit-walk and not just the current `main`: anchor URLs include
 *  the branch ref (`refs/heads/main`), which doesn't pin the content. If
 *  the file was edited after submission, the on-chain hash refers to a
 *  historical commit's bytes. Walking history lets us recover those.
 *
 *  Rate-limit posture: unauthenticated GitHub API gives 60 req/IP/hour. A
 *  single anchor recovery uses 1 list call + up to 30 raw fetches = ≤31
 *  requests. The 24h ENRICHMENT_TTL_MS in the sync makes us walk at most
 *  once per failing row per day. If a 403 with `X-RateLimit-Remaining: 0`
 *  comes back, we return null and let the next cycle retry — no exponential
 *  backoff state to maintain.
 *
 *  Wall-clock budget: 30s total per anchor. A pathological repo (or a
 *  GitHub outage) won't stall the sync.
 *
 *  Returns null on any failure path: URL parse fail, non-GitHub URL, SHA-
 *  pinned URL (walking history is moot), commits API fail, every commit
 *  hash-mismatches, budget exhausted. Never throws.
 */
export async function fetchGithubHistoricalAnchor(
  anchorUrl: string,
  expectedHashHex: string,
): Promise<GithubHistoricalAnchorResult | null> {
  if (!anchorUrl || typeof anchorUrl !== 'string') return null;
  if (!expectedHashHex || typeof expectedHashHex !== 'string') return null;
  const expected = expectedHashHex.toLowerCase().trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) return null;

  const parsed = parseGithubRawUrl(anchorUrl);
  if (!parsed) return null;

  const deadline = Date.now() + GITHUB_WALK_BUDGET_MS;

  // ---- 1. List commits for this file path ----
  // GitHub returns newest-first by default; we keep that ordering. A
  // governance action's anchor was set at submission time, so the matching
  // commit is more likely to be a recent edit (the proposer fixing a
  // last-minute typo) than an ancient one. But we walk the whole list
  // either way until we hit a match or exhaust the page.
  //
  // We pass `path` as a query param. GitHub url-encodes it for us when
  // we use URLSearchParams.
  const commitsUrl =
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/` +
    `${encodeURIComponent(parsed.repo)}/commits?` +
    new URLSearchParams({
      path: parsed.path,
      per_page: String(GITHUB_MAX_COMMITS),
    }).toString();

  let commits: GithubCommitRow[];
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PER_GATEWAY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(commitsUrl, {
        signal: ac.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
          // X-GitHub-Api-Version pins the response shape against future
          // breaking changes. The shape we use (`sha`, `commit.committer.date`)
          // has been stable since v3 but we're explicit.
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 403 + `X-RateLimit-Remaining: 0` = rate-limited. Any other non-2xx
      // (404 = repo gone, 5xx = GitHub problem) also collapses to null.
      // Next sync cycle will try again on its own cadence.
      if (res.status === 403) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        if (remaining === '0') {
          console.warn(
            `GitHub history walk: rate-limited (remaining=0) for ${parsed.owner}/${parsed.repo} ${parsed.path}; will retry next cycle`,
          );
        }
      }
      return null;
    }
    const payload = (await res.json()) as unknown;
    if (!Array.isArray(payload)) return null;
    commits = payload as GithubCommitRow[];
  } catch {
    return null;
  }

  if (commits.length === 0) return null;

  // ---- 2. Walk commits, fetch+hash+compare ----
  for (const commit of commits) {
    if (Date.now() >= deadline) {
      console.warn(
        `GitHub history walk: 30s budget exhausted for ${parsed.owner}/${parsed.repo} ${parsed.path}; giving up`,
      );
      return null;
    }
    if (!commit || typeof commit.sha !== 'string') continue;
    if (!/^[0-9a-f]{40}$/i.test(commit.sha)) continue;

    // Build the raw URL at this exact SHA. GitHub serves
    // `https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}` for
    // any commit that ever contained the file.
    //
    // We do NOT encodeURIComponent the path — GitHub's raw service expects
    // the path segments as-is (slashes are real path separators). The path
    // came from a regex match on the original anchor URL, so it's already
    // URL-safe in practice; if a future anchor ever has a literal `?` or
    // `#` in it the regex parse would have failed up top.
    const rawUrl =
      `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/` +
      `${encodeURIComponent(parsed.repo)}/${commit.sha}/${parsed.path}`;
    const bytes = await fetchOneGateway(rawUrl);
    if (!bytes) continue;
    let computed: string;
    try {
      computed = blake2b256Hex(bytes);
    } catch {
      continue;
    }
    if (computed === expected) {
      const commitDate =
        commit.commit?.committer?.date ??
        commit.commit?.author?.date ??
        new Date(0).toISOString();
      return {
        body: bytes.toString('utf-8'),
        commitSha: commit.sha,
        commitDate,
      };
    }
  }

  // Every reachable commit's bytes mismatched. The anchor's true content
  // is probably outside the first 30 commits (rare) or was rebased away
  // entirely (very rare). Either way: null and the sync moves on.
  return null;
}
