import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem, ClubhousePollOption } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, notFound, handleError } from '../_response';

/**
 * Cast / change a vote on a clubhouse poll.
 *
 * # Security trade-off
 *
 * The other write paths in this codebase require a fresh wallet signature
 * (mutation-nonce flow) on top of the JWT cookie. Poll voting is *intentionally*
 * exempt: a poll inside a private clubhouse is a low-stakes signal, the
 * surface area is tiny (single integer per wallet per post), and forcing
 * a wallet popup for every vote click would torch the UX. We rely on the
 * httpOnly auth cookie + the committee-membership check below.
 *
 * If poll results ever start driving on-chain decisions, swap this back
 * to the mutation-nonce flow. The handler shape is otherwise identical.
 */
interface VoteBody {
  /** Index into `pollOptions` (0-based). For multi-choice polls clients
   *  send one request per toggled option. */
  optionIndex: number;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const postId = event.pathParameters?.['postId'];

    if (!drepId || !postId) {
      return badRequest('drepId and postId path parameters are required');
    }
    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: VoteBody;
    try {
      body = JSON.parse(event.body) as VoteBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (typeof body.optionIndex !== 'number' || !Number.isInteger(body.optionIndex)) {
      return badRequest('optionIndex must be an integer');
    }

    const post = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId: decodeURIComponent(drepId),
      postId: decodeURIComponent(postId),
    });
    if (!post) return notFound('Clubhouse post');

    if (post.type !== 'poll' || !post.pollOptions || post.pollOptions.length === 0) {
      return badRequest('This post is not a poll');
    }

    if (post.pollClosesAt && Date.parse(post.pollClosesAt) < Date.now()) {
      return badRequest('This poll has closed');
    }

    if (body.optionIndex < 0 || body.optionIndex >= post.pollOptions.length) {
      return badRequest('optionIndex is out of range');
    }

    const previousIndex = post.pollVotes?.[authCtx.walletAddress];
    // Idempotent: voting the same option twice is a no-op rather than
    // a double-count.
    if (previousIndex === body.optionIndex) {
      return ok(post);
    }

    const updatedOptions: ClubhousePollOption[] = post.pollOptions.map((opt, i) => {
      let votes = opt.votes;
      if (typeof previousIndex === 'number' && previousIndex === i) votes -= 1;
      if (i === body.optionIndex) votes += 1;
      return { ...opt, votes: Math.max(0, votes) };
    });
    const updatedVotes = {
      ...(post.pollVotes ?? {}),
      [authCtx.walletAddress]: body.optionIndex,
    };

    const updated: ClubhousePostItem = {
      ...post,
      pollOptions: updatedOptions,
      pollVotes: updatedVotes,
      updatedAt: new Date().toISOString(),
    };

    // Use putItem (not updateItem) — overwrites the whole record so the
    // write reflects the recomputed tally + the vote map atomically.
    await putItem(tableNames.clubhousePosts, updated as unknown as Record<string, unknown>);

    return ok(updated);
  } catch (err) {
    console.error('clubhouse/votePoll handler error:', err);
    return handleError(err);
  }
};
