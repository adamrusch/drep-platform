import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { putItem, getItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem, DRepCommitteeItem } from '../../lib/types';
import { extractAuthContext, requireRole } from '../../middleware/role-guard';
import { created, badRequest, forbidden, notFound, handleError } from '../_response';

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

    // Privileged-role prerequisite: only committee-tier wallets may post in a clubhouse.
    // The committee-membership check below is a second gate that scopes the post to a
    // specific committee. (Was previously a no-op because `delegator` was accepted.)
    requireRole(authCtx, 'lead_drep', 'committee_member', 'trusted_delegator');

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
    const memberRecord = committee.members.find((m) => m.walletAddress === authCtx.walletAddress);
    const isLeadOfThisCommittee = committee.leadWallet === authCtx.walletAddress;
    const isMember = isLeadOfThisCommittee || memberRecord !== undefined;

    if (!isMember) {
      return forbidden('You must be a member of this committee to post');
    }

    // Mark as a DRep post only when the caller is the lead or a committee member
    // of THIS committee (not via global role). Trusted delegators are members
    // but not DRep speakers.
    const isDRepPost =
      isLeadOfThisCommittee ||
      memberRecord?.role === 'lead_drep' ||
      memberRecord?.role === 'committee_member';
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
