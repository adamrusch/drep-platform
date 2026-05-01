import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { putItem, getItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem, DRepCommitteeItem } from '../../lib/types';
import { extractAuthContext, requireRole } from '../../middleware/role-guard';
import { created, badRequest, forbidden, notFound, internalError, handleError } from '../_response';

interface CreatePostBody {
  body: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];

    if (!drepId) {
      return badRequest('drepId path parameter is required');
    }

    // Only committee members or lead_drep of this committee can post
    requireRole(authCtx, 'lead_drep', 'committee_member', 'trusted_delegator', 'delegator');

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let reqBody: CreatePostBody;
    try {
      reqBody = JSON.parse(event.body) as CreatePostBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!reqBody.body || reqBody.body.trim().length === 0) {
      return badRequest('body is required');
    }
    if (reqBody.body.length > 50_000) {
      return badRequest('body exceeds maximum length of 50,000 characters');
    }

    // Verify committee exists
    const committee = await getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
      drepId: decodeURIComponent(drepId),
      SK: 'COMMITTEE',
    });
    if (!committee) {
      return notFound('DRep committee');
    }

    // Check membership: lead_drep or committee member of this specific DRep
    const isMember =
      committee.leadWallet === authCtx.walletAddress ||
      committee.members.some((m) => m.walletAddress === authCtx.walletAddress);

    if (!isMember && !authCtx.roles.includes('lead_drep')) {
      return forbidden('You must be a member of this committee to post');
    }

    const isDRepPost =
      authCtx.roles.includes('lead_drep') || authCtx.roles.includes('committee_member');
    const now = new Date().toISOString();
    const postId = ulid();

    const post: ClubhousePostItem = {
      drepId: decodeURIComponent(drepId),
      postId,
      authorWallet: authCtx.walletAddress,
      isDRepPost,
      body: reqBody.body.trim(),
      comments: [],
      createdAt: now,
      updatedAt: now,
    };

    await putItem(tableNames.clubhousePosts, post as unknown as Record<string, unknown>);

    return created(post);
  } catch (err) {
    console.error('clubhouse/createPost handler error:', err);
    return handleError(err);
  }
};
