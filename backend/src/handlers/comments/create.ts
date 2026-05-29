import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { getItem, tableNames, transactWrite } from '../../lib/dynamodb';
import type { CommentItem, CommentVoteItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import {
  validateMutationNonce,
  verifyWalletSignature,
  buildMutationMessage,
} from '../../lib/auth';
import { lookupRecognition, lookupStake } from '../../lib/recognition';
import { writeAuditEvent } from '../../lib/audit';
import { created, badRequest, unauthorized, notFound, handleError } from '../_response';

interface CreateCommentBody {
  body: string;
  isPublic: boolean;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
  /** Optional — when present, this comment is a reply to the named
   *  comment. Replies are restricted to ONE level deep; replying to a
   *  reply is rejected with 400. */
  parentCommentId?: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const actionId = event.pathParameters?.['actionId'];

    if (!actionId) {
      return badRequest('actionId path parameter is required');
    }

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: CreateCommentBody;
    try {
      body = JSON.parse(event.body) as CreateCommentBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!body.body || typeof body.body !== 'string' || body.body.trim().length === 0) {
      return badRequest('body is required and must be non-empty');
    }
    if (body.body.length > 10_000) {
      return badRequest('body exceeds maximum length of 10,000 characters');
    }
    if (typeof body.isPublic !== 'boolean') {
      return badRequest('isPublic must be a boolean');
    }
    if (!body.mutationNonce || !body.mutationSignature || !body.mutationKey) {
      return badRequest('mutationNonce, mutationSignature, and mutationKey are required');
    }
    if (body.parentCommentId !== undefined && typeof body.parentCommentId !== 'string') {
      return badRequest('parentCommentId must be a string when provided');
    }

    // Validate mutation nonce
    const nonceResult = await validateMutationNonce(body.mutationNonce, authCtx.walletAddress);
    if (!nonceResult.valid) {
      return unauthorized(nonceResult.reason ?? 'Invalid mutation nonce');
    }

    // Verify mutation signature. `buildMutationMessage` is the single source
    // of truth for the signed-message format — the nonce issuer uses the
    // same helper, so the byte string we verify here matches exactly what
    // the wallet signed.
    const mutationMessage = buildMutationMessage(body.mutationNonce, authCtx.walletAddress);
    const sigResult = verifyWalletSignature(authCtx.walletAddress, mutationMessage, {
      signature: body.mutationSignature,
      key: body.mutationKey,
    });
    if (!sigResult.valid) {
      return unauthorized(sigResult.reason ?? 'Invalid mutation signature');
    }

    const decodedActionId = decodeURIComponent(actionId);

    // Verify governance action exists
    const actionExists = await getItem(tableNames.governanceActions, {
      actionId: decodedActionId,
      SK: 'ACTION',
    });
    if (!actionExists) {
      return notFound('Governance action');
    }

    // Reply-depth guard: replies must target a TOP-LEVEL comment. We look
    // up the parent and reject if it itself is a reply. This is the API-
    // layer enforcement of "exactly one level deep" — UI also hides the
    // Reply affordance on replies, but the server must not trust that.
    if (body.parentCommentId !== undefined) {
      const parent = await getItem<CommentItem>(tableNames.comments, {
        actionId: decodedActionId,
        commentId: body.parentCommentId,
      });
      if (!parent) {
        return notFound('Parent comment');
      }
      if (parent.parentCommentId !== undefined) {
        return badRequest('Replies to replies are not allowed');
      }
    }

    const isDRep = authCtx.roles.includes('lead_drep') || authCtx.roles.includes('committee_member');
    const now = new Date().toISOString();
    const commentId = ulid();

    // Best-effort display recognition + LIVE stake snapshot (for the
    // author's seed upvote). The recognition lookup is fire-and-forget —
    // a stale or absent stake-ada pill is fine. The stake lookup matters
    // more: it's the seed-vote weight. If both upstreams fail we still
    // create the comment, but the seed vote weight is zero (better than
    // failing the post over an upstream hiccup).
    const [recognition, stake] = await Promise.all([
      lookupRecognition(authCtx.walletAddress),
      lookupStake(authCtx.walletAddress),
    ]);

    // Seed-vote lovelace. When stake lookup fails we still create the
    // comment with supportLovelace=0n — better UX than failing the post.
    //
    // `seedLovelace` (string) is the value that gets snapshotted on the
    // per-vote row in `comment_votes` — that table's `lovelace` field is
    // a string, so we leave it as-is. `seedLovelaceBig` (bigint) is the
    // initial value of the running counter on the `comments` row, which
    // since the 2026-05-28 P0-2 fix is a DDB `N` (so the vote handler's
    // `ADD :delta` works). See the vote handler's `migrateLegacySupport-
    // Lovelace` for how legacy `S`-typed rows are upgraded on first vote.
    const seedLovelace = stake.lovelace ?? '0';
    let seedLovelaceBig: bigint;
    try {
      seedLovelaceBig = BigInt(seedLovelace);
    } catch {
      seedLovelaceBig = 0n;
    }

    const commentItem: CommentItem = {
      actionId: decodedActionId,
      commentId,
      walletAddress: authCtx.walletAddress,
      body: body.body.trim(),
      isPublic: body.isPublic,
      isDRep,
      createdAt: now,
      updatedAt: now,
      supportLovelace: seedLovelaceBig,
      upvoteCount: 1,
      downvoteCount: 0,
      ...(body.parentCommentId ? { parentCommentId: body.parentCommentId } : {}),
      ...(recognition.stakeAda ? { stakeAda: recognition.stakeAda } : {}),
      ...(recognition.drep ? { drep: recognition.drep } : {}),
    };

    const seedVote: CommentVoteItem = {
      commentId,
      stakeAddress: authCtx.walletAddress,
      actionId: decodedActionId,
      vote: 'up',
      lovelace: seedLovelace,
      votedAt: now,
    };

    // Atomic write: comment row + seed-vote row land together or not at
    // all. If we ever crashed between the two, the support level on the
    // comment would be a lie (claims +stake without a vote row backing
    // it). TransactWrite gives us all-or-nothing.
    await transactWrite([
      {
        Put: {
          TableName: tableNames.comments,
          Item: commentItem as unknown as Record<string, unknown>,
        },
      },
      {
        Put: {
          TableName: tableNames.commentVotes,
          Item: seedVote as unknown as Record<string, unknown>,
        },
      },
    ]);

    // Best-effort audit-log write (Oracle's #1 credibility item, 2026-05-28).
    // Fires AFTER the mutation succeeds — never blocks/fails the response.
    // Metadata is minimal + non-sensitive (IDs only, NOT the comment body).
    await writeAuditEvent({
      entityType: 'comment',
      entityId: commentId,
      eventType: 'comment.created',
      actorWallet: authCtx.walletAddress,
      metadata: {
        actionId: decodedActionId,
        isPublic: body.isPublic,
        isDRep,
        ...(body.parentCommentId ? { parentCommentId: body.parentCommentId } : {}),
      },
    });

    return created(commentItem);
  } catch (err) {
    console.error('comments/create handler error:', err);
    return handleError(err);
  }
};
