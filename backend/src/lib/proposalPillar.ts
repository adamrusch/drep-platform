/**
 * Proposal-pillar (gov.tools) fallback metadata client.
 *
 * Many active mainnet governance actions ship without an on-chain CIP-108
 * anchor — Treasury Withdrawals especially. But many of those proposals
 * were drafted in the gov.tools proposal-discussion forum *before* going
 * on-chain. The forum's API exposes those drafts and links them back to
 * the on-chain submission via `prop_submission_tx_hash` (when populated)
 * and via the link list `proposal_links[].prop_link`.
 *
 * This module is a best-effort fallback ONLY. The on-chain CIP-108 anchor
 * is canonical when present. Errors here MUST never propagate to the
 * caller — they degrade silently to `null` so the sync continues.
 *
 * IMPORTANT design choice: the API exposes `filters[content][...]` deep
 * filters per the OpenAPI spec, but they are silently ignored at runtime
 * (the relation is on a deep object — Strapi v4 doesn't filter through
 * it without extra config). So we fetch the entire list (capped to 500
 * items, well above the actual ~70 today), index it client-side by
 * tx_hash and by link URL, and answer lookups from the cache. The cache
 * has a 10-min TTL — drafts don't change between sync cycles.
 */
import type { GovernanceReference } from './types';

// ---- Public types ----

export interface ProposalPillarEntry {
  /** Numeric forum ID (used to synthesize the public discussion URL). */
  id: number;
  /** Drafted title — maps to GovernanceAction.title. */
  prop_name?: string;
  /** Drafted abstract — maps to GovernanceAction.abstract. */
  prop_abstract?: string;
  /** Drafted motivation — maps to GovernanceAction.motivation. */
  prop_motivation?: string;
  /** Drafted rationale — maps to GovernanceAction.rationale. */
  prop_rationale?: string;
  /** Submitting user's gov.tools handle. Display-only. */
  user_govtool_username?: string;
  /** When `prop_submitted=true`, the on-chain submission tx hash. */
  prop_submission_tx_hash?: string;
  /** Reference list — each entry has a URI and label. */
  references?: GovernanceReference[];
  /** Synthesized public discussion URL. */
  proposalPillarUrl: string;
}

// ---- Tunables ----

const API_BASE = 'https://be.pdf.gov.tools/api';
const REQUEST_TIMEOUT_MS = 5_000;
const RESPONSE_MAX_BYTES = 1_048_576; // 1 MB
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PAGE_SIZE = 500; // upper bound — actual total is ~70 today

// ---- Module-level cache ----

interface CacheState {
  fetchedAt: number;
  byTxHash: Map<string, ProposalPillarEntry>;
  byLink: Map<string, ProposalPillarEntry>;
}

let _cache: CacheState | null = null;
let _inflight: Promise<CacheState | null> | null = null;

// ---- Internal raw-API shapes (loose; we project them ourselves) ----

interface RawListItem {
  id: number;
  attributes?: {
    user_govtool_username?: string;
    content?:
      | RawContent
      | { attributes?: RawContent; data?: { id?: number; attributes?: RawContent } };
  };
}

interface RawContent {
  prop_name?: string;
  prop_abstract?: string;
  prop_motivation?: string;
  prop_rationale?: string;
  prop_submitted?: boolean;
  prop_submission_tx_hash?: string;
  proposal_links?: Array<{ id?: number; prop_link?: string; prop_link_text?: string }>;
}

interface RawListResponse {
  data?: RawListItem[];
  meta?: { pagination?: { total?: number } };
}

// ---- Helpers ----

/** Strapi v4 returns deep relations either as `{attributes: ...}`,
 *  `{data: {attributes: ...}}`, or sometimes flat. Normalize. */
function pickContentAttrs(raw: RawListItem): RawContent | null {
  const c = raw.attributes?.content as
    | RawContent
    | { attributes?: RawContent; data?: { attributes?: RawContent } }
    | undefined;
  if (!c || typeof c !== 'object') return null;
  const obj = c as Record<string, unknown>;
  if ('attributes' in obj && obj.attributes && typeof obj.attributes === 'object') {
    return obj.attributes as RawContent;
  }
  if ('data' in obj && obj.data && typeof obj.data === 'object') {
    const data = obj.data as { attributes?: RawContent };
    if (data.attributes && typeof data.attributes === 'object') return data.attributes;
  }
  return c as RawContent;
}

function projectEntry(raw: RawListItem): ProposalPillarEntry | null {
  const id = raw.id;
  if (typeof id !== 'number') return null;
  const ca = pickContentAttrs(raw);
  if (!ca) return null;
  const refs: GovernanceReference[] = [];
  for (const l of ca.proposal_links ?? []) {
    const uri = typeof l?.prop_link === 'string' ? l.prop_link.trim() : '';
    if (!uri) continue;
    const label = typeof l.prop_link_text === 'string' && l.prop_link_text.trim().length > 0
      ? l.prop_link_text.trim()
      : uri;
    refs.push({ label, uri });
  }
  const entry: ProposalPillarEntry = {
    id,
    proposalPillarUrl: `https://gov.tools/proposal_discussion/${id}`,
  };
  if (raw.attributes?.user_govtool_username) {
    entry.user_govtool_username = raw.attributes.user_govtool_username;
  }
  if (typeof ca.prop_name === 'string' && ca.prop_name.trim().length > 0) {
    entry.prop_name = ca.prop_name.trim();
  }
  if (typeof ca.prop_abstract === 'string' && ca.prop_abstract.trim().length > 0) {
    entry.prop_abstract = ca.prop_abstract.trim();
  }
  if (typeof ca.prop_motivation === 'string' && ca.prop_motivation.trim().length > 0) {
    entry.prop_motivation = ca.prop_motivation.trim();
  }
  if (typeof ca.prop_rationale === 'string' && ca.prop_rationale.trim().length > 0) {
    entry.prop_rationale = ca.prop_rationale.trim();
  }
  if (typeof ca.prop_submission_tx_hash === 'string' && ca.prop_submission_tx_hash.length > 0) {
    entry.prop_submission_tx_hash = ca.prop_submission_tx_hash.toLowerCase();
  }
  if (refs.length > 0) entry.references = refs;
  return entry;
}

/** Read the entire response body but bail if it exceeds RESPONSE_MAX_BYTES.
 *  Mirrors the streaming guard in `fetchAnchorBody`. */
async function readBoundedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > RESPONSE_MAX_BYTES) {
      throw new Error(`proposal-pillar response exceeded ${RESPONSE_MAX_BYTES} bytes`);
    }
    return new TextDecoder('utf-8').decode(buf);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > RESPONSE_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(`proposal-pillar response exceeded ${RESPONSE_MAX_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
}

async function fetchPage(): Promise<RawListResponse | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${API_BASE}/proposals?pagination%5BpageSize%5D=${PAGE_SIZE}`;
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(
        `proposal-pillar list HTTP ${res.status} — falling back to no-pillar enrichment`,
      );
      return null;
    }
    const text = await readBoundedText(res);
    const json = JSON.parse(text) as RawListResponse;
    return json;
  } catch (err) {
    console.warn('proposal-pillar list fetch failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCache(): Promise<CacheState | null> {
  const t0 = Date.now();
  const raw = await fetchPage();
  if (!raw) return null;
  const items = Array.isArray(raw.data) ? raw.data : [];
  const byTxHash = new Map<string, ProposalPillarEntry>();
  const byLink = new Map<string, ProposalPillarEntry>();
  let entries = 0;
  let txKeys = 0;
  let linkKeys = 0;
  for (const r of items) {
    const e = projectEntry(r);
    if (!e) continue;
    entries++;
    if (e.prop_submission_tx_hash) {
      byTxHash.set(e.prop_submission_tx_hash.toLowerCase(), e);
      txKeys++;
    }
    for (const ref of e.references ?? []) {
      const key = ref.uri.toLowerCase();
      // First-write-wins so the lowest-id (older) draft wins on collision.
      // Avoids an arbitrary later draft hijacking a stable link.
      if (!byLink.has(key)) {
        byLink.set(key, e);
        linkKeys++;
      }
    }
  }
  const ms = Date.now() - t0;
  console.log(
    `proposal-pillar cache refresh: entries=${entries} tx_keys=${txKeys} link_keys=${linkKeys} latency_ms=${ms}`,
  );
  return { fetchedAt: Date.now(), byTxHash, byLink };
}

async function getCache(): Promise<CacheState | null> {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache;
  }
  // Single-flight: if a refresh is in progress, await it.
  if (_inflight) {
    return _inflight;
  }
  _inflight = (async () => {
    try {
      const fresh = await refreshCache();
      if (fresh) {
        _cache = fresh;
        return fresh;
      }
      // Refresh failed — return stale cache if we have one (degraded mode),
      // otherwise null. This lets the sync ride out brief outages.
      if (_cache) {
        console.warn('proposal-pillar refresh failed; serving stale cache');
        return _cache;
      }
      return null;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// ---- Public API ----

/**
 * Look up a forum draft by the on-chain submission tx hash.
 *
 * Returns null when:
 *   - the API is unreachable / 5xx / 4xx (logs a warning),
 *   - no submitted draft has that tx hash,
 *   - the cache is empty and refresh failed.
 */
export async function findByOnChainTxHash(
  txHash: string,
): Promise<ProposalPillarEntry | null> {
  if (typeof txHash !== 'string' || txHash.length === 0) return null;
  const cache = await getCache();
  if (!cache) {
    console.warn(`proposal-pillar lookup miss (no cache): tx=${txHash.slice(0, 16)}...`);
    return null;
  }
  const hit = cache.byTxHash.get(txHash.toLowerCase());
  if (hit) {
    console.log(`proposal-pillar tx hit: tx=${txHash.slice(0, 16)}... id=${hit.id}`);
    return hit;
  }
  return null;
}

/**
 * Look up a forum draft by anchor URL — useful when the on-chain anchor
 * exists but its body is unparseable, OR when the action's `anchorUrl`
 * matches one of a draft's `proposal_links[].prop_link` entries.
 *
 * Returns null when no link matches or the cache is unavailable.
 */
export async function findByAnchorUrl(url: string): Promise<ProposalPillarEntry | null> {
  if (typeof url !== 'string' || url.length === 0) return null;
  const cache = await getCache();
  if (!cache) {
    console.warn(`proposal-pillar lookup miss (no cache): url=${url.slice(0, 60)}`);
    return null;
  }
  const hit = cache.byLink.get(url.toLowerCase());
  if (hit) {
    console.log(`proposal-pillar url hit: url=${url.slice(0, 60)} id=${hit.id}`);
    return hit;
  }
  return null;
}

/**
 * Test-only: clear the module-level cache. Not exported via the public
 * surface in any production code path.
 */
export function _resetCacheForTests(): void {
  _cache = null;
  _inflight = null;
}
