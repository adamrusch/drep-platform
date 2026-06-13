/**
 * GET /api/avatar/{hash} — content-addressed DRep avatar.
 *
 * Bytes were validated and persisted at sync time (`avatar-store` in
 * `lib/dreps/avatarStore.ts`); this handler is a thin Lambda boundary
 * over `serveAvatar`. The URL is content-addressed (sha256) so the bytes
 * are immutable — we serve them with `cache-control: max-age=31536000,
 * immutable` and CloudFront caches them at the edge.
 *
 * Any invalid input (malformed hash, missing object, missing bucket) is a
 * 404 — never a 500 — so a broken upstream avatar URL never surfaces an
 * error to the user (the SPA falls back to the client-side identicon).
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { serveAvatar } from '../../lib/dreps/avatarServe';
import { s3AvatarBucket } from '../../lib/dreps/avatarStore';

// Lazy module-scope bucket so cold-start doesn't construct it twice; same
// pattern the DDB doc client uses across this codebase.
let _bucket: ReturnType<typeof s3AvatarBucket> | undefined;
function bucket(): ReturnType<typeof s3AvatarBucket> | undefined {
  if (_bucket) return _bucket;
  try {
    _bucket = s3AvatarBucket();
    return _bucket;
  } catch (err) {
    // Bucket env var missing: log once on cold-start, then serve every
    // request as 404 (fail closed).
    console.warn('avatar handler: AVATAR_S3_BUCKET unset; every request will 404:', err);
    return undefined;
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const hashRaw = event.pathParameters?.['hash'];
  const res = await serveAvatar(bucket(), hashRaw);

  // HTTP API v2 lets us set `isBase64Encoded` on the response so the
  // binary body round-trips intact through API Gateway. The 404 path has
  // no body and is plain text — same shape, no encoding needed.
  if (res.status === 200 && res.body) {
    return {
      statusCode: 200,
      headers: res.headers,
      isBase64Encoded: true,
      body: Buffer.from(res.body).toString('base64'),
    };
  }
  return {
    statusCode: 404,
    headers: res.headers,
    body: 'not found',
  };
};
