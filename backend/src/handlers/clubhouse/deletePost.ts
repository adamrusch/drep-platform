import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, deleteItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem, DRepCommitteeItem } from '../../lib/types';
import {
  extractAuthContext,
  requireOwnerOrCommitteeLead,
} from '../../middleware/role-guard';
import { noContent, badRequest, notFound, internalError, handleError } from '../_response';

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

    requireOwnerOrCommitteeLead(authCtx, existing.authorWallet, committee);

    await deleteItem(tableNames.clubhousePosts, {
      drepId: decodedDrepId,
      postId: decodedPostId,
    });

    return noContent();
  } catch (err) {
    console.error('clubhouse/deletePost handler error:', err);
    return handleError(err);
  }
};
