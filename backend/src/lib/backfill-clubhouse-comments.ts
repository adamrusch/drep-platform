/**
 * Testable lib for the Clubhouse-comments backfill (P0-3 migration).
 *
 * The actual one-shot CLI lives at
 * `backend/scripts/backfill-clubhouse-comments.ts` (outside `src/` so
 * it doesn't bundle into Lambda artifacts). This file extracts the
 * pure helpers so the migration's correctness can be pinned by
 * vitest without crossing the rootDir boundary.
 *
 * Pattern mirrors `backend/src/lib/backfill-legacy-comment-seeds.ts`
 * (Batch F, item #16) — see that module's header for the rationale.
 *
 * Exports:
 *   - `clubhouseCommentsPostKeyFor` — composite-key constructor
 *   - `computeClubhouseCommentDepths` — derives per-comment depth from
 *     an inline `comments[]` array (the legacy shape we're migrating
 *     FROM)
 *   - `maxClubhouseCommentCreatedAt` — `lastReplyAt` calculation
 *   - `estimateClubhousePostRowSize` — stuck-post pre-check threshold
 *     companion
 *   - `STUCK_POST_SIZE_THRESHOLD_BYTES` — generous 350KB ceiling so
 *     the pre-check catches posts approaching the 400KB DDB cap
 */

export interface InlineCommentForBackfill {
  commentId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
  parentCommentId?: string;
}

/** Stuck-post pre-check threshold. Items larger than this are flagged
 *  in the backfill report so the owner can decide whether to hand-prune.
 *  The DDB hard cap is 400KB; we use 350KB so the check fires BEFORE
 *  the cap is breached. */
export const STUCK_POST_SIZE_THRESHOLD_BYTES = 350_000;

/** Compose the PK used by the `clubhouse_comments` table. The format
 *  is part of the table contract — exported so every read/write site
 *  uses the same shape. Mirrors `clubhouseCommentPostKey` in
 *  `lib/types.ts` (kept duplicated here so the backfill helper has
 *  zero cross-deps on the live handler module graph). */
export function clubhouseCommentsPostKeyFor(drepId: string, postId: string): string {
  return `${drepId}#${postId}`;
}

/**
 * Compute depth-on-row for every inline comment by walking the parent
 * chain in-memory. Returns a map of `commentId -> depth` clamped to
 * the legal 0/1/2 range. The walk caps at 3 hops defensively against
 * a corrupted inline array — legitimate chains resolve in <= 2 hops
 * because the live handler rejects depth-3 writes.
 *
 * Orphan parents (parentCommentId points at a comment not present in
 * the array) increment depth once then break. This matches the live
 * handler's defensive walk against corrupt data.
 */
export function computeClubhouseCommentDepths(
  comments: readonly InlineCommentForBackfill[],
): Map<string, 0 | 1 | 2> {
  const byId = new Map<string, InlineCommentForBackfill>();
  for (const c of comments) byId.set(c.commentId, c);
  const depths = new Map<string, 0 | 1 | 2>();
  for (const c of comments) {
    let cursor: InlineCommentForBackfill | undefined = c;
    let depth = 0;
    for (let i = 0; i < 3 && cursor?.parentCommentId; i++) {
      depth += 1;
      cursor = byId.get(cursor.parentCommentId);
      if (!cursor) break;
    }
    const clamped = Math.min(depth, 2) as 0 | 1 | 2;
    depths.set(c.commentId, clamped);
  }
  return depths;
}

/** Sum of all `createdAt` strings → max. Returns undefined when the
 *  list is empty. Lexicographic compare works on ISO-8601 with UTC `Z`
 *  suffix; this is the same convention the rest of the codebase uses. */
export function maxClubhouseCommentCreatedAt(
  comments: readonly InlineCommentForBackfill[],
): string | undefined {
  let max: string | undefined;
  for (const c of comments) {
    if (typeof c.createdAt !== 'string') continue;
    if (!max || c.createdAt.localeCompare(max) > 0) max = c.createdAt;
  }
  return max;
}

/** Rough byte-size of a row — used by the stuck-post pre-check.
 *  JSON.stringify is the same rule-of-thumb DDB uses for item-size
 *  accounting (within a small constant factor). */
export function estimateClubhousePostRowSize(row: unknown): number {
  return Buffer.byteLength(JSON.stringify(row), 'utf8');
}
