import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, deleteItem, queryItems, tableNames } from '../../lib/dynamodb';
import {
  clubhouseCommentPostKey,
  type ClubhouseCommentRowItem,
  type ClubhousePostItem,
  type DRepCommitteeItem,
} from '../../lib/types';
import {
  extractAuthContext,
  requireOwnerOrCommitteeLead,
} from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { noContent, badRequest, notFound, handleError } from '../_response';

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

    const decodedDrepId = decodeURIComponent(drepId);
    const decodedPostId = decodeURIComponent(postId);

    const existing = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId: decodedDrepId,
      postId: decodedPostId,
    });

    if (!existing) {
      return notFound('Clubhouse post');
    }

    // P0-4 (2026-05-28): scope the `lead_drep` override to the SPECIFIC
    // committee that owns this post's clubhouse, not globally. Before
    // this fix, ANY wallet holding `lead_drep` ANYWHERE could delete
    // any post in any clubhouse — including the system-generated
    // auto-posts owned by the governance feed.
    //
    // We look up the committee row for this post's drepId and then
    // delegate the gate to `requireOwnerOrCommitteeLead`, which only
    // honors the override when the caller actually leads THIS
    // committee (matches `committee.leadWallet` or appears in
    // `committee.members` with role `lead_drep`). If no committee row
    // exists (auto-post clubhouse where no committee was ever set up),
    // the override has no effect and the owner-only branch applies.
    const committee = await getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
      drepId: decodedDrepId,
      SK: 'COMMITTEE',
    }).catch((err) => {
      // Defensive: a transient DDB Get failure should NOT silently
      // promote to a global override. The owner-only branch still
      // applies; only the lead override is lost during the outage.
      console.warn(
        `clubhouse/deletePost: committee lookup failed for ${decodedDrepId}; falling back to owner-only:`,
        err,
      );
      return undefined;
    });

    // Wrap the gate so we can audit a denial before letting the
    // AuthorizationError propagate. Security-relevant rejections are
    // the rows an incident responder needs to spot cross-committee
    // moderation attempts.
    try {
      requireOwnerOrCommitteeLead(authCtx, existing.authorWallet, committee);
    } catch (err) {
      await writeAuditEvent({
        entityType: 'clubhouse_post',
        entityId: decodedPostId,
        eventType: 'clubhouse.post.denied',
        actorWallet: authCtx.walletAddress,
        metadata: {
          surface: 'deletePost',
          drepId: decodedDrepId,
          ownerWallet: existing.authorWallet,
          reason: 'not_owner_or_lead',
        },
      });
      throw err;
    }

    await deleteItem(tableNames.clubhousePosts, {
      drepId: decodedDrepId,
      postId: decodedPostId,
    });

    // P0-3 Phase 6+ cascade (2026-05-28). Now that comments live in
    // the per-row `clubhouse_comments` table, deleting a post must
    // delete its comment rows too — otherwise we orphan rows that
    // can never be re-attached or surfaced (the post's PK is gone).
    // Idempotent by construction: re-running a partial delete picks
    // up whatever rows remain. Best-effort within the cascade: a
    // single failed comment delete logs + continues so we don't
    // leave the post un-deleted because one of N comment-row deletes
    // failed.
    const postKey = clubhouseCommentPostKey(decodedDrepId, decodedPostId);
    let cascadeDeleted = 0;
    let cascadeErrored = 0;
    try {
      let lastEvaluatedKey: Record<string, unknown> | undefined;
      do {
        const page = await queryItems<ClubhouseCommentRowItem>(
          tableNames.clubhouseComments,
          {
            keyConditionExpression: '#pk = :pk',
            expressionAttributeNames: { '#pk': 'postKey' },
            expressionAttributeValues: { ':pk': postKey },
            ...(lastEvaluatedKey ? { exclusiveStartKey: lastEvaluatedKey } : {}),
            // Slim projection — we only need the SK to delete.
            projectionExpression: 'postKey, commentId',
          },
        );
        for (const row of page.items) {
          try {
            await deleteItem(tableNames.clubhouseComments, {
              postKey: row.postKey,
              commentId: row.commentId,
            });
            cascadeDeleted++;
          } catch (err) {
            cascadeErrored++;
            console.warn(
              `clubhouse/deletePost: failed to delete comment row commentId=${row.commentId} for postKey=${postKey}:`,
              err,
            );
          }
        }
        lastEvaluatedKey = page.lastEvaluatedKey;
      } while (lastEvaluatedKey);
    } catch (err) {
      // A Query failure here doesn't roll back the post delete — the
      // post is gone and re-running the handler (or a future cleanup
      // sweep) can finish the cascade. Log so the failure is visible.
      console.warn(
        `clubhouse/deletePost: comment cascade Query failed for postKey=${postKey}:`,
        err,
      );
    }

    // Best-effort audit AFTER the delete succeeds. `cascadeDeleted`
    // tells an incident-responder how many comment rows the cascade
    // removed; combined with the source row's PITR snapshot, this is
    // enough to reconstruct the pre-delete state.
    await writeAuditEvent({
      entityType: 'clubhouse_post',
      entityId: decodedPostId,
      eventType: 'clubhouse.post.deleted',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId: decodedDrepId,
        ownerWallet: existing.authorWallet,
        cascadeDeleted,
        cascadeErrored,
      },
    });

    return noContent();
  } catch (err) {
    console.error('clubhouse/deletePost handler error:', err);
    return handleError(err);
  }
};
