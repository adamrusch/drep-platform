/**
 * Tests for the daily avatar GC sweep entry-point.
 *
 * The underlying `gcDrepAvatars` is unit-tested in
 * `lib/dreps/avatarStore.test.ts`; this file pins the wiring layer:
 *
 *   - AVATAR_S3_BUCKET unset → skipped, no S3 calls, no throw.
 *   - AVATAR_S3_BUCKET set + sweep succeeds → returns the inner result.
 *   - AVATAR_S3_BUCKET set + sweep throws → re-throws so the Lambda
 *     `Errors` metric surfaces it.
 *
 * We mock `gcDrepAvatars` + `s3AvatarBucket` at the module boundary so
 * the test doesn't construct a real `S3Client`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const gcDrepAvatarsMock = vi.fn();
const s3AvatarBucketMock = vi.fn();

vi.mock('../lib/dreps/avatarStore', () => ({
  gcDrepAvatars: (...args: unknown[]) => gcDrepAvatarsMock(...args),
  s3AvatarBucket: (...args: unknown[]) => s3AvatarBucketMock(...args),
}));

import { runGcAvatars } from './gc-avatars';

const ORIGINAL_BUCKET = process.env['AVATAR_S3_BUCKET'];

beforeEach(() => {
  gcDrepAvatarsMock.mockReset();
  s3AvatarBucketMock.mockReset();
});

afterEach(() => {
  if (ORIGINAL_BUCKET === undefined) {
    delete process.env['AVATAR_S3_BUCKET'];
  } else {
    process.env['AVATAR_S3_BUCKET'] = ORIGINAL_BUCKET;
  }
});

describe('runGcAvatars — wiring layer', () => {
  it('returns skipped=true when AVATAR_S3_BUCKET is unset (no-op)', async () => {
    delete process.env['AVATAR_S3_BUCKET'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await runGcAvatars();
      expect(result.skipped).toBe(true);
      expect(result.scanned).toBe(0);
      expect(result.deleted).toBe(0);
      expect(s3AvatarBucketMock).not.toHaveBeenCalled();
      expect(gcDrepAvatarsMock).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('runs gcDrepAvatars and returns its result when AVATAR_S3_BUCKET is set', async () => {
    process.env['AVATAR_S3_BUCKET'] = 'drep-platform-test-avatars';
    const fakeBucket = { tag: 'fake' };
    s3AvatarBucketMock.mockReturnValueOnce(fakeBucket);
    gcDrepAvatarsMock.mockResolvedValueOnce({ scanned: 17, deleted: 3 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await runGcAvatars(1_700_000_000_000);
      expect(s3AvatarBucketMock).toHaveBeenCalledWith('drep-platform-test-avatars');
      expect(gcDrepAvatarsMock).toHaveBeenCalledWith({
        bucket: fakeBucket,
        nowMs: 1_700_000_000_000,
      });
      expect(result).toEqual({ scanned: 17, deleted: 3, skipped: false });
    } finally {
      log.mockRestore();
    }
  });

  it('re-throws when gcDrepAvatars throws (lets the Lambda Errors metric fire)', async () => {
    process.env['AVATAR_S3_BUCKET'] = 'drep-platform-test-avatars';
    s3AvatarBucketMock.mockReturnValueOnce({ tag: 'fake' });
    gcDrepAvatarsMock.mockRejectedValueOnce(new Error('S3 ListObjects failed'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(runGcAvatars()).rejects.toThrow('S3 ListObjects failed');
    } finally {
      err.mockRestore();
    }
  });
});
