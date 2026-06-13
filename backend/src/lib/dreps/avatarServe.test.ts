// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com),
// Apache-2.0. Modified for drep-platform.

import { describe, it, expect } from 'vitest';
import { serveAvatar } from './avatarServe';
import { AVATAR_KEY_PREFIX, type AvatarBucket } from './avatarStore';

class FakeBucket implements AvatarBucket {
  store = new Map<string, { bytes: Uint8Array; contentType: string; uploaded: Date }>();
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.store.set(key, { bytes: new Uint8Array(bytes), contentType, uploaded: new Date() });
  }
  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const obj = this.store.get(key);
    if (!obj) return null;
    return { bytes: obj.bytes, contentType: obj.contentType };
  }
  async delete(): Promise<void> {}
  async list(): Promise<Array<{ key: string; uploaded: Date }>> {
    return [];
  }
}

const HASH = '6'.repeat(64);
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

describe('serveAvatar', () => {
  it('serves a stored object with content-type and an immutable cache header', async () => {
    const bucket = new FakeBucket();
    await bucket.put(AVATAR_KEY_PREFIX + HASH, BYTES, 'image/webp');

    const res = await serveAvatar(bucket, HASH);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['content-length']).toBe(String(BYTES.byteLength));
    expect(res.body).toEqual(BYTES);
  });

  it('404s on a miss', async () => {
    const bucket = new FakeBucket();
    const res = await serveAvatar(bucket, '7'.repeat(64));
    expect(res.status).toBe(404);
    expect(res.body).toBeUndefined();
  });

  it('404s on a malformed hash without touching the bucket', async () => {
    const bucket = new FakeBucket();
    expect((await serveAvatar(bucket, 'not-a-hash')).status).toBe(404);
    expect((await serveAvatar(bucket, `${'8'.repeat(63)}X`)).status).toBe(404);
    expect((await serveAvatar(bucket, undefined)).status).toBe(404);
  });

  it('404s when the bucket binding is missing', async () => {
    expect((await serveAvatar(undefined, HASH)).status).toBe(404);
  });
});
