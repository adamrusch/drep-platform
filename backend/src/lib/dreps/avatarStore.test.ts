// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com),
// Apache-2.0. Modified for drep-platform.
//
// Avatar-store unit tests. The DDB layer is mocked behind the `repo`
// injection point; the S3 bucket is an in-memory fake.

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  storeDrepAvatars,
  gcDrepAvatars,
  AVATAR_KEY_PREFIX,
  type AvatarBucket,
  type AvatarRepo,
} from './avatarStore';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function imageResponse(bytes: Uint8Array, contentType = 'image/png'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

interface FakeBucketObject {
  bytes: Uint8Array;
  contentType: string;
  uploaded: Date;
}

/** In-memory `AvatarBucket` that tracks uploaded objects so the GC
 *  assertions can read them back. */
class FakeBucket implements AvatarBucket {
  store = new Map<string, FakeBucketObject>();
  constructor(private nowSrc: { now(): Date } = { now: () => new Date() }) {}
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.store.set(key, { bytes: new Uint8Array(bytes), contentType, uploaded: this.nowSrc.now() });
  }
  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const obj = this.store.get(key);
    if (!obj) return null;
    return { bytes: obj.bytes, contentType: obj.contentType };
  }
  async delete(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }
  async list(prefix: string): Promise<Array<{ key: string; uploaded: Date }>> {
    return Array.from(this.store.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, uploaded: v.uploaded }));
  }
  /** Test helper: pre-seed an object with an explicit uploaded date. */
  preseed(key: string, bytes: Uint8Array, uploaded: Date, contentType = 'image/png'): void {
    this.store.set(key, { bytes, contentType, uploaded });
  }
}

/** Simple in-memory repo. Track every method call so the failure-rotation
 *  test can assert on `markFetchFailed` calls. */
function makeRepo(initial: Array<{ drepId: string; imageUrl: string }>): AvatarRepo & {
  storedCalls: Array<{ drepId: string; hash: string; storedUrl: string }>;
  markedFailedCalls: Array<{ drepId: string; nowMs: number }>;
  rows: Array<{ drepId: string; imageUrl: string }>;
} {
  const rows = [...initial];
  const storedCalls: Array<{ drepId: string; hash: string; storedUrl: string }> = [];
  const markedFailedCalls: Array<{ drepId: string; nowMs: number }> = [];
  const referenced = new Set<string>();
  return {
    storedCalls,
    markedFailedCalls,
    rows,
    async listNeedingAvatar(limit) {
      return rows.slice(0, limit);
    },
    async setStored(drepId, hash, storedUrl) {
      storedCalls.push({ drepId, hash, storedUrl });
      referenced.add(hash);
      // Drop the row so a subsequent run wouldn't re-fetch it.
      const idx = rows.findIndex((r) => r.drepId === drepId);
      if (idx >= 0) rows.splice(idx, 1);
    },
    async markFetchFailed(drepId, nowMs) {
      markedFailedCalls.push({ drepId, nowMs });
    },
    async clearOrphanedStore() {
      return 0;
    },
    async listReferencedHashes() {
      return referenced;
    },
  };
}

describe('storeDrepAvatars', () => {
  let bucket: FakeBucket;
  beforeEach(() => {
    bucket = new FakeBucket();
  });

  it('downloads, stores at avatars/<sha256>, and stamps the row', async () => {
    const repo = makeRepo([{ drepId: 'st-ok', imageUrl: 'https://img.example/ok.png' }]);
    const fetchImpl = (async () => imageResponse(PNG_BYTES)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 1_000 });
    expect(r.stored).toBe(1);
    expect(r.failed).toBe(0);

    const hash = sha256Hex(PNG_BYTES);
    const stored = await bucket.get(AVATAR_KEY_PREFIX + hash);
    expect(stored).not.toBeNull();
    expect(stored!.contentType).toBe('image/png');

    expect(repo.storedCalls).toEqual([
      { drepId: 'st-ok', hash, storedUrl: 'https://img.example/ok.png' },
    ]);
  });

  it('dedupes identical bytes across DReps under one S3 object', async () => {
    const repo = makeRepo([
      { drepId: 'st-a', imageUrl: 'https://img.example/a.png' },
      { drepId: 'st-b', imageUrl: 'https://img.example/b.png' },
    ]);
    const fetchImpl = (async () => imageResponse(PNG_BYTES)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo });
    expect(r.stored).toBe(2);
    // Both rows hash to the same key.
    const keys = Array.from(bucket.store.keys());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(AVATAR_KEY_PREFIX + sha256Hex(PNG_BYTES));
  });

  it('rejects a non-https source without fetching', async () => {
    const repo = makeRepo([
      { drepId: 'st-http', imageUrl: 'http://img.example/insecure.png' },
    ]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return imageResponse(PNG_BYTES);
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 5_000 });
    expect(calls).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.stored).toBe(0);
    expect(repo.markedFailedCalls).toEqual([{ drepId: 'st-http', nowMs: 5_000 }]);
  });

  // SSRF defense: a DRep whose `image` URL points at a private / loopback /
  // link-local host must be rejected before any socket opens. The most
  // dangerous target is EC2 IMDSv1 (169.254.169.254) — if the sync Lambda
  // ever runs with a VPC attachment or an IAM role a hostile DRep could
  // enumerate, the pivot must never fire the fetch.
  const SSRF_HOSTS: Array<[string, string]> = [
    ['loopback ipv4', 'https://127.0.0.1/x.png'],
    ['loopback ipv4 (127/8)', 'https://127.5.5.5/x.png'],
    ['localhost hostname', 'https://localhost/x.png'],
    ['IMDSv1 link-local', 'https://169.254.169.254/latest/meta-data/x.png'],
    ['other link-local', 'https://169.254.1.1/x.png'],
    ['RFC-1918 10/8', 'https://10.0.0.5/x.png'],
    ['RFC-1918 172.16/12', 'https://172.20.1.1/x.png'],
    ['RFC-1918 192.168/16', 'https://192.168.1.1/x.png'],
    ['zero-net', 'https://0.0.0.0/x.png'],
    ['CGNAT', 'https://100.64.5.5/x.png'],
    ['multicast', 'https://224.0.0.1/x.png'],
  ];
  for (const [label, url] of SSRF_HOSTS) {
    it(`SSRF: rejects ${label} without fetching`, async () => {
      const repo = makeRepo([{ drepId: `st-ssrf-${label}`, imageUrl: url }]);
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return imageResponse(PNG_BYTES);
      }) as unknown as typeof fetch;

      const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 1 });
      expect(calls).toBe(0);
      expect(r.failed).toBe(1);
      expect(r.stored).toBe(0);
    });
  }

  it('rejects a disallowed content type and leaves the row unchanged', async () => {
    const repo = makeRepo([
      { drepId: 'st-svg', imageUrl: 'https://img.example/evil.svg' },
    ]);
    const fetchImpl = (async () => imageResponse(PNG_BYTES, 'image/svg+xml')) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 9_999 });
    expect(r.failed).toBe(1);
    expect(repo.storedCalls).toEqual([]);
    expect(repo.markedFailedCalls).toEqual([{ drepId: 'st-svg', nowMs: 9_999 }]);
  });

  it('rejects an oversize body', async () => {
    const repo = makeRepo([{ drepId: 'st-big', imageUrl: 'https://img.example/big.png' }]);
    const big = new Uint8Array(256 * 1024 + 1);
    const fetchImpl = (async () => imageResponse(big)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 1 });
    expect(r.failed).toBe(1);
    expect(repo.storedCalls).toEqual([]);
  });

  it('rejects an oversize declared content-length before reading the body', async () => {
    const repo = makeRepo([
      { drepId: 'st-declared', imageUrl: 'https://img.example/declared.png' },
    ]);
    // Tiny body, but the declared length exceeds the cap.
    const fetchImpl = (async () =>
      new Response(PNG_BYTES, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(256 * 1024 + 1),
        },
      })) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 1 });
    expect(r.failed).toBe(1);
    expect(repo.storedCalls).toEqual([]);
  });

  it('a fetch error stamps the row with the run time', async () => {
    const repo = makeRepo([
      { drepId: 'st-stamp', imageUrl: 'https://img.example/dead.png' },
    ]);
    const fetchImpl = (async () => {
      throw new Error('host down');
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 42_000 });
    expect(r.failed).toBe(1);
    expect(repo.markedFailedCalls).toEqual([{ drepId: 'st-stamp', nowMs: 42_000 }]);
  });

  it('one bad source does not abort the pass (the second row still stores)', async () => {
    const repo = makeRepo([
      { drepId: 'st-bad', imageUrl: 'https://img.example/dead.png' },
      { drepId: 'st-ok', imageUrl: 'https://img.example/ok.png' },
    ]);
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('dead.png')) throw new Error('host down');
      return imageResponse(PNG_BYTES);
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ bucket, fetchImpl, repo, nowMs: 1 });
    expect(r.stored).toBe(1);
    expect(r.failed).toBe(1);
    expect(repo.storedCalls.map((c) => c.drepId)).toEqual(['st-ok']);
    expect(repo.markedFailedCalls.map((c) => c.drepId)).toEqual(['st-bad']);
  });
});

describe('gcDrepAvatars', () => {
  it('deletes orphaned objects past the grace period, keeps referenced ones', async () => {
    const bucket = new FakeBucket();
    const keepHash = '3'.repeat(64);
    const dropHash = '4'.repeat(64);
    const baseTime = Date.now();
    // Both uploaded "now"; the GC nowMs is 25h ahead, putting the orphan
    // past the 24h grace window.
    bucket.preseed(AVATAR_KEY_PREFIX + keepHash, PNG_BYTES, new Date(baseTime));
    bucket.preseed(AVATAR_KEY_PREFIX + dropHash, PNG_BYTES, new Date(baseTime));

    const repo: AvatarRepo = {
      async listNeedingAvatar() {
        return [];
      },
      async setStored() {},
      async markFetchFailed() {},
      async clearOrphanedStore() {
        return 0;
      },
      async listReferencedHashes() {
        return new Set([keepHash]);
      },
    };

    const r = await gcDrepAvatars({
      bucket,
      nowMs: baseTime + 25 * 60 * 60 * 1000,
      repo,
    });
    expect(r.deleted).toBe(1);
    expect(await bucket.get(AVATAR_KEY_PREFIX + keepHash)).not.toBeNull();
    expect(await bucket.get(AVATAR_KEY_PREFIX + dropHash)).toBeNull();
  });

  it('keeps a fresh orphan inside the grace period', async () => {
    const bucket = new FakeBucket();
    const orphanHash = '5'.repeat(64);
    const baseTime = Date.now();
    bucket.preseed(AVATAR_KEY_PREFIX + orphanHash, PNG_BYTES, new Date(baseTime));

    const repo: AvatarRepo = {
      async listNeedingAvatar() {
        return [];
      },
      async setStored() {},
      async markFetchFailed() {},
      async clearOrphanedStore() {
        return 0;
      },
      async listReferencedHashes() {
        return new Set<string>();
      },
    };

    const r = await gcDrepAvatars({ bucket, nowMs: baseTime + 5 * 60 * 60 * 1000, repo });
    expect(r.deleted).toBe(0);
    expect(await bucket.get(AVATAR_KEY_PREFIX + orphanHash)).not.toBeNull();
  });
});
