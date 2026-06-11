// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com),
// Apache-2.0. Modified for drep-platform.
//
// Serve core for `GET /api/avatar/{hash}` — a plain S3 read. The URL is
// content-addressed (sha256 of the bytes), so the response is
// immutable-cacheable and no validation beyond the hash shape is needed at
// request time. All download hardening runs at store time (see
// `avatarStore.ts`).

import type { AvatarBucket } from './avatarStore';
import { AVATAR_KEY_PREFIX } from './avatarStore';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HASH_RE = /^[0-9a-f]{64}$/;

/** Response shape: status + headers + (when present) base64-encoded body.
 *  Kept transport-neutral so the same logic is callable from a Lambda
 *  handler (which produces an `APIGatewayProxyResultV2`) AND from tests
 *  (which assert on the headers without needing a full AWS-shaped event). */
export interface AvatarServeResponse {
  status: 200 | 404;
  headers: Record<string, string>;
  /** Set when `status === 200`. Body is bytes; the Lambda boundary
   *  base64-encodes for `isBase64Encoded: true`. */
  body?: Uint8Array;
}

/** Serves one stored avatar; any invalid input or miss is a 404, never a 500.
 *  The bucket can be `undefined` so a misconfigured Lambda fails closed
 *  with a 404 rather than throwing. */
export async function serveAvatar(
  bucket: AvatarBucket | undefined,
  hash: string | undefined,
): Promise<AvatarServeResponse> {
  if (!bucket || !hash || !HASH_RE.test(hash)) {
    return { status: 404, headers: { 'content-type': 'text/plain' } };
  }
  const obj = await bucket.get(AVATAR_KEY_PREFIX + hash);
  if (!obj) {
    return { status: 404, headers: { 'content-type': 'text/plain' } };
  }
  return {
    status: 200,
    headers: {
      'content-type': obj.contentType,
      'content-length': String(obj.bytes.byteLength),
      'cache-control': CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
    body: obj.bytes,
  };
}
