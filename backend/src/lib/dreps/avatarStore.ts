// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com),
// Apache-2.0. Modified for drep-platform.
//
// Avatar store pass: downloads each DRep's CIP-119 image once and stores
// it in S3, content-addressed by the sha256 of its bytes. Run from the
// directory-sync Lambda after the PROFILE rows are written.
//
// The download hardening that used to run per-request in the serve proxy
// (https-only, timeout, type allowlist, size cap) runs here, once per
// image. Failures stamp `imageFetchFailedAt` so broken sources rotate to
// the back of the work queue instead of starving fresh rows; one bad
// avatar never aborts the pass.
//
// Adapted from DRep Talk's Cloudflare R2 implementation: the bucket
// abstraction now uses the AWS SDK `S3Client` and crypto uses Node's
// built-in `node:crypto` (no `crypto.subtle` dependency).

import { createHash } from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { queryItems, updateItem, tableNames } from '../dynamodb';
import type { DRepDirectoryItem } from '../types';

/** Maximum accepted image size (256 KB): larger is mislinked or hostile. */
const MAX_IMAGE_BYTES = 256 * 1024;
/** Upstream fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 8_000;
/** Raster types only. SVG is rejected: it can carry scripts. */
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
/** S3 key prefix; the full key is `avatars/<sha256-hex>`. */
export const AVATAR_KEY_PREFIX = 'avatars/';
/** Default cap on rows scanned per run. The backlog drains over successive
 *  sync cycles; the cap stops one pass from monopolising the directory
 *  sync's Lambda budget. */
const DEFAULT_RUN_LIMIT = 25;

/**
 * Minimal S3 client interface the helpers need — production wires this
 * to the AWS SDK `S3Client`; tests inject an in-memory fake.
 */
export interface AvatarBucket {
  /** Put bytes at `key`. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Get bytes at `key` (resolves to null on a 404 / miss). */
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Delete a batch of keys. The implementation must accept any size; the
   *  S3 wrapper splits into 1000-key chunks under the hood. */
  delete(keys: readonly string[]): Promise<void>;
  /** Paginated list of all objects under `prefix`. Returns the full
   *  inventory (the GC sweep needs to see every key once). Each object's
   *  `uploaded` is the LastModified server timestamp. */
  list(prefix: string): Promise<Array<{ key: string; uploaded: Date }>>;
}

export interface AvatarStoreDeps {
  bucket: AvatarBucket;
  /** Image fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
  /** Max downloads per run; the backlog drains over successive sync cycles. */
  limit?: number;
  /** Failure stamp time (unix ms); defaults to Date.now(), injected for tests. */
  nowMs?: number;
}

export interface AvatarStoreResult {
  /** Rows pulled from the work queue this run (orphan-cleared rows excluded). */
  scanned: number;
  stored: number;
  cleared: number;
  failed: number;
}

/** sha256 of the given bytes as lowercase hex. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Downloads and validates one image. Returns null on any rejection:
 * non-https, fetch error/timeout, disallowed type, oversize, or empty body.
 */
async function fetchValidatedImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      // Explicitly empty headers: never send cookies or auth to the image host.
      headers: {},
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(contentType)) return null;

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;

  let arrayBuf: ArrayBuffer;
  try {
    arrayBuf = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > MAX_IMAGE_BYTES) return null;

  return { bytes: new Uint8Array(arrayBuf), contentType };
}

// ---- DDB access helpers ----
//
// These are co-located here (rather than under `lib/dynamodb.ts`) because
// they're the avatar-store sync's domain logic — the rest of the codebase
// has no business knowing about `imageContentHash` / `imageFetchFailedAt`
// shapes. Keeping them here also makes the sync trivially testable: the
// test layer mocks `queryItems` + `updateItem` and never has to know about
// our column shapes.

/** Eligible row picked by the sync's work queue: a PROFILE row whose
 *  `image` URL doesn't yet hash-match the stored `imageContentHash`. */
interface AvatarWorkRow {
  drepId: string;
  imageUrl: string;
}

/**
 * Select PROFILE rows whose upstream `image` URL is set AND either
 * (a) has no `imageStoredUrl` yet, or (b) the stored URL has changed.
 * Rotation: rows with a recent `imageFetchFailedAt` fall to the back of
 * the queue. We do this client-side after Query (no GSI on
 * `imageFetchFailedAt` — adding one would inflate write amplification on
 * the directory sync for a feature that runs at a small steady-state row
 * rate).
 */
async function listProfilesNeedingAvatar(limit: number): Promise<AvatarWorkRow[]> {
  // Query the sparse `entityType-votingPower-index` GSI to enumerate all
  // PROFILE rows, same access path the list handler uses.
  const accumulated: DRepDirectoryItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  for (let round = 0; round < 10; round++) {
    const page = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
      indexName: 'entityType-votingPower-index',
      keyConditionExpression: '#et = :entityType',
      expressionAttributeNames: { '#et': 'entityType' },
      expressionAttributeValues: { ':entityType': 'DREP_PROFILE' },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    accumulated.push(...page.items);
    if (!page.lastEvaluatedKey) break;
    cursor = page.lastEvaluatedKey;
  }
  // Eligible: an upstream image URL is set AND the stored snapshot is missing
  // or stale.
  const eligible = accumulated.filter((r) => {
    const url = typeof r.image === 'string' ? r.image : null;
    if (!url) return false;
    return r.imageStoredUrl !== url;
  });
  // Rotation: rows that failed most recently sort LAST. Rows with no failure
  // stamp sort first. Within each group, drepId lexicographic order keeps
  // the iteration stable across runs.
  eligible.sort((a, b) => {
    const fa = typeof a.imageFetchFailedAt === 'number' ? a.imageFetchFailedAt : 0;
    const fb = typeof b.imageFetchFailedAt === 'number' ? b.imageFetchFailedAt : 0;
    if (fa !== fb) return fa - fb;
    return a.drepId < b.drepId ? -1 : a.drepId > b.drepId ? 1 : 0;
  });
  return eligible.slice(0, limit).map((r) => ({ drepId: r.drepId, imageUrl: r.image as string }));
}

/** Stamp success: write the hash + stored URL, and clear any failure mark. */
async function setProfileImageStored(
  drepId: string,
  hash: string,
  storedUrl: string,
): Promise<void> {
  await updateItem(
    tableNames.drepDirectory,
    { drepId, SK: 'PROFILE' },
    'SET #h = :h, #u = :u REMOVE #f',
    {
      '#h': 'imageContentHash',
      '#u': 'imageStoredUrl',
      '#f': 'imageFetchFailedAt',
    },
    { ':h': hash, ':u': storedUrl },
  );
}

/** Stamp failure timestamp so the queue rotates the row to the back. */
async function setProfileImageFetchFailed(drepId: string, nowMs: number): Promise<void> {
  await updateItem(
    tableNames.drepDirectory,
    { drepId, SK: 'PROFILE' },
    'SET #f = :f',
    { '#f': 'imageFetchFailedAt' },
    { ':f': nowMs },
  );
}

/** Clear the avatar fields on a row whose upstream image disappeared. The
 *  stored S3 object becomes unreferenced and the GC sweep will reap it
 *  after the grace period. */
async function clearProfileImageStored(drepId: string): Promise<void> {
  await updateItem(
    tableNames.drepDirectory,
    { drepId, SK: 'PROFILE' },
    'REMOVE #h, #u, #f',
    {
      '#h': 'imageContentHash',
      '#u': 'imageStoredUrl',
      '#f': 'imageFetchFailedAt',
    },
    {},
  );
}

/** Iterate every PROFILE row whose `image` URL is null but a stored hash
 *  remains, and return their drepIds. Used by the orphan-clear sweep. */
async function listProfilesWithOrphanedStore(): Promise<string[]> {
  const accumulated: DRepDirectoryItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  for (let round = 0; round < 10; round++) {
    const page = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
      indexName: 'entityType-votingPower-index',
      keyConditionExpression: '#et = :entityType',
      expressionAttributeNames: { '#et': 'entityType' },
      expressionAttributeValues: { ':entityType': 'DREP_PROFILE' },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    accumulated.push(...page.items);
    if (!page.lastEvaluatedKey) break;
    cursor = page.lastEvaluatedKey;
  }
  return accumulated
    .filter((r) => {
      const url = typeof r.image === 'string' ? r.image : null;
      const stored = typeof r.imageStoredUrl === 'string' ? r.imageStoredUrl : null;
      return !url && stored;
    })
    .map((r) => r.drepId);
}

/** Return the set of `imageContentHash` values referenced by any PROFILE row.
 *  Consumed by the GC sweep to decide which S3 objects to keep. */
async function listReferencedImageHashes(): Promise<Set<string>> {
  const out = new Set<string>();
  const accumulated: DRepDirectoryItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  for (let round = 0; round < 10; round++) {
    const page = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
      indexName: 'entityType-votingPower-index',
      keyConditionExpression: '#et = :entityType',
      expressionAttributeNames: { '#et': 'entityType' },
      expressionAttributeValues: { ':entityType': 'DREP_PROFILE' },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    accumulated.push(...page.items);
    if (!page.lastEvaluatedKey) break;
    cursor = page.lastEvaluatedKey;
  }
  for (const r of accumulated) {
    const h = typeof r.imageContentHash === 'string' ? r.imageContentHash : null;
    if (h) out.add(h);
  }
  return out;
}

/** Public surface used by the sync entrypoint AND the unit tests (which
 *  inject their own DB layer through `repo`). The default `repo`
 *  delegates to the DDB helpers above; tests override every method.
 *
 *  Splitting the data layer out is what makes this pass unit-testable
 *  without spinning up DynamoDB local: the upstream R2/D1 test fixture
 *  had a real cloudflare:test fixture; we don't, so we expose a tiny
 *  interface and fake it. */
export interface AvatarRepo {
  listNeedingAvatar(limit: number): Promise<AvatarWorkRow[]>;
  setStored(drepId: string, hash: string, storedUrl: string): Promise<void>;
  markFetchFailed(drepId: string, nowMs: number): Promise<void>;
  clearOrphanedStore(): Promise<number>;
  listReferencedHashes(): Promise<Set<string>>;
}

const defaultRepo: AvatarRepo = {
  listNeedingAvatar: listProfilesNeedingAvatar,
  setStored: setProfileImageStored,
  markFetchFailed: setProfileImageFetchFailed,
  clearOrphanedStore: async () => {
    const ids = await listProfilesWithOrphanedStore();
    for (const id of ids) {
      try {
        await clearProfileImageStored(id);
      } catch (err) {
        console.warn(`avatar-store: failed to clear orphaned store for ${id}:`, err);
      }
    }
    return ids.length;
  },
  listReferencedHashes: listReferencedImageHashes,
};

/**
 * Run one avatar-store pass. Pure I/O glue around the per-row fetch +
 * hash + upload + DB stamp; bounded by `limit` so a misconfigured run
 * can't monopolise the Lambda budget.
 */
export async function storeDrepAvatars(
  deps: AvatarStoreDeps & { repo?: AvatarRepo },
): Promise<AvatarStoreResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const limit = deps.limit ?? DEFAULT_RUN_LIMIT;
  const nowMs = deps.nowMs ?? Date.now();
  const repo = deps.repo ?? defaultRepo;

  // First null out rows whose on-chain image disappeared, so their S3
  // objects become unreferenced and the GC sweep can reap them.
  const cleared = await repo.clearOrphanedStore();

  const rows = await repo.listNeedingAvatar(limit);
  let stored = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const img = await fetchValidatedImage(row.imageUrl, fetchImpl);
      if (!img) {
        failed++;
        await repo.markFetchFailed(row.drepId, nowMs);
        continue;
      }
      const hash = sha256Hex(img.bytes);
      // Idempotent: identical bytes across DReps share one object.
      await deps.bucket.put(AVATAR_KEY_PREFIX + hash, img.bytes, img.contentType);
      await repo.setStored(row.drepId, hash, row.imageUrl);
      stored++;
    } catch (err) {
      // Isolate per-DRep failures; the stored columns stay unchanged but
      // we stamp the failure so the queue rotates the row.
      console.warn(`avatar-store: ${row.drepId} pass failed:`, err);
      failed++;
      try {
        await repo.markFetchFailed(row.drepId, nowMs);
      } catch (markErr) {
        console.warn(`avatar-store: ${row.drepId} markFailed also failed:`, markErr);
      }
    }
  }
  return { scanned: rows.length, stored, cleared, failed };
}

/** Grace period before an unreferenced object is deleted. Covers the window
 *  between an object landing in S3 and its DDB row being visible to the
 *  GC's referenced-set read. */
const AVATAR_GC_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AvatarGcDeps {
  bucket: AvatarBucket;
  nowMs: number;
  /** Max deletions per run; the backlog drains over successive cron runs. */
  deleteLimit?: number;
  /** Test injection point for the avatar repo. */
  repo?: AvatarRepo;
}

/**
 * Delete `avatars/<hash>` objects no DRep row references anymore, once
 * they're older than the grace period. Bounded deletions per run.
 */
export async function gcDrepAvatars(deps: AvatarGcDeps): Promise<{ scanned: number; deleted: number }> {
  const repo = deps.repo ?? defaultRepo;
  const deleteLimit = deps.deleteLimit ?? 200;
  const referenced = await repo.listReferencedHashes();

  const inventory = await deps.bucket.list(AVATAR_KEY_PREFIX);
  let scanned = 0;
  const toDelete: string[] = [];
  for (const obj of inventory) {
    scanned++;
    if (toDelete.length >= deleteLimit) continue;
    const hash = obj.key.slice(AVATAR_KEY_PREFIX.length);
    if (referenced.has(hash)) continue;
    if (deps.nowMs - obj.uploaded.getTime() < AVATAR_GC_GRACE_MS) continue;
    toDelete.push(obj.key);
  }
  if (toDelete.length > 0) {
    await deps.bucket.delete(toDelete);
  }
  return { scanned, deleted: toDelete.length };
}

// ---- S3 bucket adapter for production use ----

/** Lazy module-level S3 client — same pattern as `lib/dynamodb.ts`. */
let _s3Client: S3Client | null = null;
function s3Client(): S3Client {
  if (!_s3Client) {
    _s3Client = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
  }
  return _s3Client;
}

/**
 * Build an `AvatarBucket` backed by AWS S3. Bucket name comes from the
 * `AVATAR_S3_BUCKET` env var the CDK stack sets on the Lambdas.
 */
export function s3AvatarBucket(bucketName?: string): AvatarBucket {
  const name = bucketName ?? process.env['AVATAR_S3_BUCKET'];
  if (!name) {
    throw new Error('AVATAR_S3_BUCKET env var (or explicit bucketName) is required');
  }
  return {
    async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      await s3Client().send(
        new PutObjectCommand({
          Bucket: name,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          // Disable server-side decompression — bytes are immutable and
          // we want fast unmodified delivery.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    },
    async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
      try {
        const res = await s3Client().send(new GetObjectCommand({ Bucket: name, Key: key }));
        if (!res.Body) return null;
        const chunks: Uint8Array[] = [];
        // Node 18+ `getReader()` route is the most portable.
        const reader = (res.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> })
          .transformToByteArray;
        if (typeof reader === 'function') {
          const bytes = await reader.call(res.Body);
          return {
            bytes,
            contentType: res.ContentType ?? 'application/octet-stream',
          };
        }
        // Fallback for older runtimes.
        for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        return { bytes: merged, contentType: res.ContentType ?? 'application/octet-stream' };
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === 'NoSuchKey' || code === 'NotFound') return null;
        throw err;
      }
    },
    async delete(keys: readonly string[]): Promise<void> {
      if (keys.length === 0) return;
      // S3 DeleteObjects caps at 1000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) {
        const slice = keys.slice(i, i + 1000);
        await s3Client().send(
          new DeleteObjectsCommand({
            Bucket: name,
            Delete: {
              Objects: slice.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
      }
    },
    async list(prefix: string): Promise<Array<{ key: string; uploaded: Date }>> {
      const out: Array<{ key: string; uploaded: Date }> = [];
      let continuation: string | undefined;
      do {
        const res = await s3Client().send(
          new ListObjectsV2Command({
            Bucket: name,
            Prefix: prefix,
            ContinuationToken: continuation,
          }),
        );
        for (const obj of res.Contents ?? []) {
          if (!obj.Key) continue;
          out.push({ key: obj.Key, uploaded: obj.LastModified ?? new Date(0) });
        }
        continuation = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuation);
      return out;
    },
  };
}
