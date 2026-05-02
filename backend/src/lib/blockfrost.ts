import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import blake2b from 'blake2b';
import type {
  GovernanceAction,
  GovernanceActionType,
  GovernanceActionStatus,
  GovernanceReference,
} from './types';
import { summarizeGovernanceDescription } from './governanceSummary';

// ---- Secrets Manager ----

const secretsClient = new SecretsManagerClient({ region: process.env['SES_REGION'] ?? 'us-east-1' });
let _apiKeyCache: string | null = null;

async function getBlockfrostApiKey(): Promise<string> {
  if (_apiKeyCache) return _apiKeyCache;
  // Support both direct key (legacy) and secret name path
  const nameOrKey = process.env['BLOCKFROST_SECRET_NAME'] ?? process.env['BLOCKFROST_API_KEY'];
  if (!nameOrKey) throw new Error('BLOCKFROST_SECRET_NAME environment variable is not set');
  if (!nameOrKey.includes('/')) {
    _apiKeyCache = nameOrKey;
    return nameOrKey;
  }
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: nameOrKey }));
  if (!result.SecretString) throw new Error('Blockfrost secret has no string value');
  _apiKeyCache = result.SecretString;
  return _apiKeyCache;
}

// ---- Client setup ----

let _client: BlockFrostAPI | null = null;

async function getClient(): Promise<BlockFrostAPI> {
  if (!_client) {
    const apiKey = await getBlockfrostApiKey();
    const network = process.env['CARDANO_NETWORK'] ?? 'mainnet';
    _client = new BlockFrostAPI({
      projectId: apiKey,
      network: network as 'mainnet' | 'preview' | 'preprod',
      requestTimeout: 8_000,
      retrySettings: {
        limit: 2,
        methods: ['GET'],
        statusCodes: [429, 500, 502, 503, 504],
        errorCodes: ['ECONNRESET', 'ETIMEDOUT'],
        // IMPORTANT: defer to got's default `computedValue`. The previous
        // version returned `attemptCount * 1000` unconditionally, forcing
        // got to retry on EVERY error — including 404s — because the
        // built-in statusCodes filter only kicks in when calculateDelay
        // returns 0. Returning the computedValue passes the filter through.
        calculateDelay: ({ computedValue }) => computedValue,
      },
    });
  }
  return _client;
}

export async function getBlockfrostClient(): Promise<BlockFrostAPI> {
  return getClient();
}

// ---- Typed local interfaces (not importing from @blockfrost/openapi to avoid version skew) ----
// Field names below are confirmed against Blockfrost's live schema:
// `governance_type` is a snake_case enum (`treasury_withdrawals`, `info_action`, ...);
// `expiration` is the epoch deadline (NOT `expired_epoch_deadline`).

/**
 * NOTE: only `tx_hash`, `cert_index`, `governance_type` are guaranteed —
 * Blockfrost's proposal *listing* endpoint returns just those three. The
 * detail endpoint (`getGovernanceAction`) populates the rest. Treat every
 * other field as optional in any code that may be looking at a stub.
 */
export interface BlockfrostProposal {
  tx_hash: string;
  cert_index: number;
  governance_type: string;
  deposit?: string;
  return_address?: string;
  governance_description?: Record<string, unknown> | null;
  ratified_epoch?: number | null;
  enacted_epoch?: number | null;
  dropped_epoch?: number | null;
  expired_epoch?: number | null;
  /** Epoch at which this proposal expires (always present per Blockfrost schema). */
  expiration?: number | null;
}

export interface BlockfrostProposalMetadata {
  tx_hash: string;
  cert_index: number;
  /** URL of the off-chain anchor JSON. */
  url: string;
  /** Hex-encoded blake2b-256 hash of the anchor body. */
  hash: string;
  /**
   * Validated CIP-108 metadata, JSON-decoded by Blockfrost when possible.
   * Can be a fully-typed object (the common case), a string when validation
   * failed, or null when Blockfrost couldn't fetch it.
   */
  json_metadata: unknown;
  /** Raw bytes of the anchor body, prefixed with `\x` and hex-encoded. */
  bytes: string;
}

export interface BlockfrostTx {
  hash: string;
  block: string;
  block_height: number;
  block_time: number;
  slot: number;
}

export interface BlockfrostDRep {
  drep_id: string;
  amount: string;
  active: boolean;
  active_epoch: number;
  has_script: boolean;
}

export interface BlockfrostDRepDelegator {
  address: string;
  amount: string;
}

export interface BlockfrostAccount {
  stake_address: string;
  active: boolean;
  active_epoch?: number | null;
  controlled_amount: string;
  rewards_sum: string;
  withdrawals_sum: string;
  reserves_sum: string;
  treasury_sum: string;
  withdrawable_amount: string;
  drep_id?: string | null;
  pool_id?: string | null;
}

export interface BlockfrostEpoch {
  epoch: number;
  start_time: number;
  end_time: number;
  first_block_time: number;
  last_block_time: number;
  block_count: number;
  tx_count: number;
  output: string;
  fees: string;
  active_stake?: string | null;
}

// ---- Map governance_type to our enum ----

function mapActionType(raw: string): GovernanceActionType {
  const mapping: Record<string, GovernanceActionType> = {
    // Snake-case (Blockfrost current schema)
    parameter_change: 'ParameterChange',
    hard_fork_initiation: 'HardForkInitiation',
    treasury_withdrawals: 'TreasuryWithdrawals',
    no_confidence: 'NoConfidence',
    update_committee: 'UpdateCommittee',
    new_committee: 'UpdateCommittee', // Alternate name in some payloads
    new_constitution: 'NewConstitution',
    info_action: 'InfoAction',
    // PascalCase (defensive — older Blockfrost docs and some indexers)
    ParameterChange: 'ParameterChange',
    HardForkInitiation: 'HardForkInitiation',
    TreasuryWithdrawals: 'TreasuryWithdrawals',
    NoConfidence: 'NoConfidence',
    UpdateCommittee: 'UpdateCommittee',
    NewConstitution: 'NewConstitution',
    InfoAction: 'InfoAction',
  };
  return mapping[raw] ?? 'InfoAction';
}

export function mapStatus(raw: BlockfrostProposal, currentEpoch: number): GovernanceActionStatus {
  if (raw.enacted_epoch != null) return 'enacted';
  if (raw.dropped_epoch != null) return 'dropped';
  if (raw.expired_epoch != null) return 'expired';
  if (raw.expiration != null && raw.expiration < currentEpoch) return 'expired';
  return 'active';
}

// ---- Wrapper functions ----

export async function listGovernanceActions(
  page = 1,
  count = 100,
): Promise<BlockfrostProposal[]> {
  const client = await getClient();
  const results = await client.governance.proposals({ page, count, order: 'desc' });
  return results as unknown as BlockfrostProposal[];
}

export async function getGovernanceAction(
  txHash: string,
  certIndex: number,
): Promise<BlockfrostProposal> {
  const client = await getClient();
  const result = await client.governance.proposal(txHash, certIndex);
  return result as unknown as BlockfrostProposal;
}

/**
 * Fetch the off-chain anchor metadata Blockfrost has indexed for this proposal.
 * Returns `null` when Blockfrost has nothing indexed (404), letting callers
 * distinguish "no anchor" from "fetch failed".
 */
export async function getProposalAnchor(
  txHash: string,
  certIndex: number,
): Promise<BlockfrostProposalMetadata | null> {
  const client = await getClient();
  try {
    const result = await client.governance.proposalMetadata(txHash, certIndex);
    return result as unknown as BlockfrostProposalMetadata;
  } catch (err) {
    // Blockfrost returns 404 with status_code=404 when there is no metadata.
    const e = err as { status_code?: number; statusCode?: number };
    if (e?.status_code === 404 || e?.statusCode === 404) return null;
    throw err;
  }
}

/** Fetch transaction details (used for `block_time` → submittedAt). */
export async function getTx(txHash: string): Promise<BlockfrostTx> {
  const client = await getClient();
  const result = await client.txs(txHash);
  return result as unknown as BlockfrostTx;
}

export async function getDRep(drepId: string): Promise<BlockfrostDRep> {
  const client = await getClient();
  const result = await client.governance.drepsById(drepId);
  return result as unknown as BlockfrostDRep;
}

export async function getDRepDelegations(
  drepId: string,
  page = 1,
  count = 100,
): Promise<BlockfrostDRepDelegator[]> {
  const client = await getClient();
  const result = await client.governance.drepsByIdDelegators(drepId, { page, count });
  return result as unknown as BlockfrostDRepDelegator[];
}

export async function getAccountInfo(stakeAddress: string): Promise<BlockfrostAccount> {
  const client = await getClient();
  const result = await client.accounts(stakeAddress);
  return result as unknown as BlockfrostAccount;
}

export async function getLatestEpoch(): Promise<BlockfrostEpoch> {
  const client = await getClient();
  const result = await client.epochsLatest();
  return result as unknown as BlockfrostEpoch;
}

// ---- Anchor fetching & verification ----

const ANCHOR_FETCH_TIMEOUT_MS = 5_000;
const ANCHOR_MAX_BYTES = 1_048_576; // 1 MB cap — anchors are usually <50 KB

/**
 * Convert Blockfrost's `\x...` hex-prefixed bytes string into a real Buffer.
 * Returns null if the input doesn't match the expected shape.
 */
function decodeBlockfrostHexBytes(raw: string | undefined | null): Buffer | null {
  if (typeof raw !== 'string') return null;
  let hex = raw;
  if (hex.startsWith('\\x')) hex = hex.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, 'hex');
}

/** Compute blake2b-256 of a buffer and return as lower-case hex. */
function blake2b256Hex(buf: Buffer): string {
  const out = Buffer.alloc(32);
  blake2b(32).update(buf).digest(out);
  return out.toString('hex');
}

export interface AnchorContent {
  url: string;
  hash: string;
  verified: boolean;
  json: Record<string, unknown> | null;
}

/**
 * Fetch a remote anchor URL with a hard timeout and size cap. Returns the raw
 * bytes plus the parsed JSON body (when valid JSON). Throws on non-2xx /
 * network errors.
 *
 * Used as a fallback when Blockfrost itself failed to retrieve / decode the
 * anchor (rare, but possible for IPFS gateways out of Blockfrost's reach).
 */
async function fetchAnchorBody(
  url: string,
): Promise<{ bytes: Buffer; json: Record<string, unknown> | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ANCHOR_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(`anchor fetch returned HTTP ${res.status}`);
    }
    // Stream-with-size-limit: we don't trust Content-Length, but we also cap reads.
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      const buf = Buffer.from(text, 'utf-8');
      if (buf.byteLength > ANCHOR_MAX_BYTES) {
        throw new Error(`anchor body exceeded ${ANCHOR_MAX_BYTES} bytes`);
      }
      return parseAnchorBuffer(buf);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > ANCHOR_MAX_BYTES) {
          await reader.cancel();
          throw new Error(`anchor body exceeded ${ANCHOR_MAX_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
    return parseAnchorBuffer(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  } finally {
    clearTimeout(timer);
  }
}

function parseAnchorBuffer(buf: Buffer): { bytes: Buffer; json: Record<string, unknown> | null } {
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(buf.toString('utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    // Body wasn't JSON; that's OK, we still return raw bytes for hash check.
  }
  return { bytes: buf, json };
}

/**
 * Combine Blockfrost-served metadata with a fetch-fallback and hash
 * verification. Always resolves (never throws) so one bad anchor cannot
 * crash a sync run.
 */
export async function resolveAnchor(
  meta: BlockfrostProposalMetadata | null,
): Promise<AnchorContent | null> {
  if (!meta) return null;

  // 1) Prefer Blockfrost's pre-decoded JSON when available.
  let json: Record<string, unknown> | null = null;
  if (meta.json_metadata && typeof meta.json_metadata === 'object' && !Array.isArray(meta.json_metadata)) {
    json = meta.json_metadata as Record<string, unknown>;
  } else if (typeof meta.json_metadata === 'string') {
    try {
      const parsed = JSON.parse(meta.json_metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through — we'll try `bytes` next.
    }
  }

  // 2) Try to verify hash from Blockfrost's `bytes` field.
  let verified = false;
  const bytesBuf = decodeBlockfrostHexBytes(meta.bytes);
  if (bytesBuf) {
    if (!json) {
      const parsed = parseAnchorBuffer(bytesBuf);
      if (parsed.json) json = parsed.json;
    }
    if (typeof meta.hash === 'string' && meta.hash.length > 0) {
      try {
        verified = blake2b256Hex(bytesBuf) === meta.hash.toLowerCase();
      } catch (err) {
        console.warn('blake2b verify failed:', err);
      }
    }
  }

  // 3) Last-resort fetch (only if Blockfrost gave us neither bytes nor json).
  if (!json && !bytesBuf && typeof meta.url === 'string' && /^https?:\/\//i.test(meta.url)) {
    try {
      const fetched = await fetchAnchorBody(meta.url);
      if (fetched.json) json = fetched.json;
      if (typeof meta.hash === 'string' && meta.hash.length > 0) {
        verified = blake2b256Hex(fetched.bytes) === meta.hash.toLowerCase();
      }
    } catch (err) {
      console.warn(`anchor fallback fetch failed for ${meta.url}:`, err);
    }
  }

  return {
    url: meta.url,
    hash: meta.hash,
    verified,
    json,
  };
}

// ---- CIP-108 body extraction ----

export interface ParsedCip108 {
  title?: string;
  abstract?: string;
  motivation?: string;
  rationale?: string;
  references?: GovernanceReference[];
}

export function parseCip108Body(json: Record<string, unknown> | null): ParsedCip108 {
  if (!json) return {};
  // CIP-108 wraps the user-readable content under `body`.
  const bodyRaw = (json['body'] ?? json) as unknown;
  if (!bodyRaw || typeof bodyRaw !== 'object') return {};
  const body = bodyRaw as Record<string, unknown>;
  const result: ParsedCip108 = {};
  if (typeof body['title'] === 'string') result.title = body['title'].trim();
  if (typeof body['abstract'] === 'string') result.abstract = body['abstract'].trim();
  if (typeof body['motivation'] === 'string') result.motivation = body['motivation'].trim();
  if (typeof body['rationale'] === 'string') result.rationale = body['rationale'].trim();
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

// ---- Higher-level mapper ----

export interface MapperContext {
  /** Optional anchor data already resolved by caller (avoids extra fetch in tests). */
  anchor?: AnchorContent | null;
  /** Optional tx submission time as ISO8601 (caller fetched the tx). */
  submittedAt?: string;
}

export function mapBlockfrostProposalToGovernanceAction(
  raw: BlockfrostProposal,
  currentEpoch: number,
  ctx: MapperContext = {},
): Omit<GovernanceAction, 'ingestedAt' | 'lastSyncedAt'> {
  const actionId = `${raw.tx_hash}#${raw.cert_index}`;
  const actionType = mapActionType(raw.governance_type);
  const cip108 = parseCip108Body(ctx.anchor?.json ?? null);
  const onchain = summarizeGovernanceDescription(actionType, raw.governance_description);

  // Title precedence: anchor title → on-chain summary → action ID
  const title = cip108.title ?? (onchain.summary || actionId);
  // Description precedence: anchor abstract → anchor motivation → on-chain summary
  const description =
    cip108.abstract ?? cip108.motivation ?? cip108.rationale ?? onchain.summary ?? '';

  return {
    actionId,
    actionType,
    title,
    description,
    submittedAt: ctx.submittedAt ?? new Date(0).toISOString(),
    epochDeadline: raw.expiration ?? 0,
    status: mapStatus(raw, currentEpoch),
    sourceMetadata: undefined,
    links: cip108.references?.map((r) => r.uri),
    // ---- Anchor fields ----
    anchorUrl: ctx.anchor?.url,
    anchorHash: ctx.anchor?.hash,
    anchorVerified: ctx.anchor != null ? ctx.anchor.verified : undefined,
    abstract: cip108.abstract,
    motivation: cip108.motivation,
    rationale: cip108.rationale,
    references: cip108.references,
    // ---- On-chain summary ----
    summary: onchain.summary || undefined,
    details: onchain.details.length > 0 ? onchain.details : undefined,
    proposerAddress: raw.return_address,
  };
}
