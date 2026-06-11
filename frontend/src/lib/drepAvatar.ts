// Sprint 5 — DRep avatar URL helpers.
//
// Avatar resolution order:
//   1. `imageContentHash` is set on the directory row: self-hosted at
//      `/api/avatar/<hash>` (content-addressed, immutable, served from S3
//      with a 1-year cache header through CloudFront). This is the
//      preferred source — bytes were validated and stored at sync time.
//   2. Otherwise: client-side cardenticon identicon, deterministically
//      keyed by the drepId so the same DRep always renders the same icon.
//      Identicon is rendered as a base64 data URL by `cardenticonDataURL`
//      and consumed via `<img src=...>`.
//
// The legacy `image` URL from the CIP-119 anchor body is NOT used
// directly anymore — too flaky (404s, CORS, mixed content). The sync
// fetches that URL once, validates, stores at the hash. If the sync
// hasn't run yet for this DRep we fall back to the identicon — the
// directory still renders.

import { cardenticonDataURL } from '@/vendor/cardenticon';

/** Same env handling as `lib/api.ts`. The avatar Lambda is mounted under
 *  `/api/avatar/{hash}` so it shares the same custom-domain host as the
 *  rest of the API. */
function apiBaseUrl(): string {
  return (
    import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL ?? '/api'
  );
}

/** Resolve the avatar URL for a DRep. Returns either the self-hosted
 *  `/api/avatar/<hash>` URL (when the directory row has a stored hash)
 *  OR a `data:image/svg+xml;base64,...` URL for the cardenticon
 *  identicon fallback. Either form is consumable by `<img src=...>`. */
export function resolveDrepAvatarUrl(args: {
  drepId: string;
  imageContentHash?: string | null;
  /** Pixel size for the identicon fallback. The self-hosted avatar is
   *  whatever resolution the upstream provided; the size attribute on
   *  the `<img>` controls the display dimensions. */
  size?: number;
}): string {
  if (typeof args.imageContentHash === 'string' && args.imageContentHash.length > 0) {
    const base = apiBaseUrl();
    // Trim a trailing slash so a base ending in `/api` doesn't produce
    // `/api//avatar/...`.
    const trimmed = base.replace(/\/+$/, '');
    return `${trimmed}/avatar/${encodeURIComponent(args.imageContentHash)}`;
  }
  return cardenticonDataURL(args.drepId, { size: args.size ?? 100 });
}
