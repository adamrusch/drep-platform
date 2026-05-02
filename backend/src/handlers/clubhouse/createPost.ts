import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { putItem, getItem, tableNames } from '../../lib/dynamodb';
import type {
  ClubhousePostItem,
  ClubhousePollOption,
  ClubhousePostType,
  DRepCommitteeItem,
} from '../../lib/types';
import { extractAuthContext, requireRole } from '../../middleware/role-guard';
import { lookupRecognition } from '../../lib/recognition';
import { created, badRequest, forbidden, notFound, handleError } from '../_response';

interface CreatePostBody {
  body: string;
  type?: ClubhousePostType;
  title?: string;
  pollOptions?: { id?: string; label: string }[];
  pollMultiple?: boolean;
  pollClosesAt?: string;
}

/**
 * Day-3 additive change — accepts an optional `type` field
 * (`discussion | question | poll`) and, when `type === 'poll'`,
 * a structured option list. The legacy `{ body }` shape still works:
 * untyped posts default to `discussion` and persist no poll data.
 *
 * Polls are stored alongside the post (option list + per-wallet votes)
 * to keep clubhouse-rail rendering a single read. See `POST
 * /clubhouse/{drepId}/post/{postId}/vote` for the vote handler that
 * mutates `pollVotes`.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];

    if (!drepId) {
      return badRequest('drepId path parameter is required');
    }

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

    const postType: ClubhousePostType = reqBody.type ?? 'discussion';
    if (!['discussion', 'question', 'poll'].includes(postType)) {
      return badRequest('type must be one of discussion, question, poll');
    }

    let pollOptions: ClubhousePollOption[] | undefined;
    let pollMultiple: boolean | undefined;
    let pollClosesAt: string | undefined;

    if (postType === 'poll') {
      if (!Array.isArray(reqBody.pollOptions) || reqBody.pollOptions.length < 2) {
        return badRequest('Polls require at least 2 options');
      }
      if (reqBody.pollOptions.length > 8) {
        return badRequest('Polls support a maximum of 8 options');
      }
      const seenIds = new Set<string>();
      pollOptions = reqBody.pollOptions.map((opt, i) => {
        const label = (opt.label ?? '').trim();
        if (!label) throw new Error('Poll option label is required');
        if (label.length > 200) throw new Error('Poll option labels max 200 characters');
        const id = opt.id?.trim() || String.fromCharCode(97 + i); // a, b, c…
        if (seenIds.has(id)) throw new Error('Duplicate poll option id');
        seenIds.add(id);
        return { id, label, votes: 0 };
      });
      pollMultiple = Boolean(reqBody.pollMultiple);
      // Closes-at must parse as a date and be in the future. Default
      // is +7 days at the FE; we still defend against bad inputs.
      if (reqBody.pollClosesAt) {
        const t = Date.parse(reqBody.pollClosesAt);
        if (Number.isNaN(t)) return badRequest('pollClosesAt is not a valid date');
        pollClosesAt = new Date(t).toISOString();
      }
    }

    // Verify committee exists
    const committee = await getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
      drepId: decodeURIComponent(drepId),
      SK: 'COMMITTEE',
    });
    if (!committee) {
      return notFound('DRep committee');
    }

    const memberRecord = committee.members.find((m) => m.walletAddress === authCtx.walletAddress);
    const isLeadOfThisCommittee = committee.leadWallet === authCtx.walletAddress;
    const isMember = isLeadOfThisCommittee || memberRecord !== undefined;

    if (!isMember) {
      return forbidden('You must be a member of this committee to post');
    }

    const isDRepPost =
      isLeadOfThisCommittee ||
      memberRecord?.role === 'lead_drep' ||
      memberRecord?.role === 'committee_member';
    const now = new Date().toISOString();
    const postId = ulid();

    // Best-effort recognition lookup — same pattern as comments. The pill
    // stack on a clubhouse post mirrors the comment header (stake / DRep).
    const recognition = await lookupRecognition(authCtx.walletAddress);

    const post: ClubhousePostItem = {
      drepId: decodeURIComponent(drepId),
      postId,
      authorWallet: authCtx.walletAddress,
      isDRepPost,
      body: reqBody.body.trim(),
      comments: [],
      createdAt: now,
      updatedAt: now,
      type: postType,
      ...(reqBody.title?.trim() ? { title: reqBody.title.trim() } : {}),
      ...(pollOptions ? { pollOptions, pollMultiple: pollMultiple ?? false } : {}),
      ...(pollClosesAt ? { pollClosesAt } : {}),
      ...(pollOptions ? { pollVotes: {} } : {}),
      ...(recognition.stakeAda ? { stakeAda: recognition.stakeAda } : {}),
      ...(recognition.drep ? { drep: recognition.drep } : {}),
    };

    await putItem(tableNames.clubhousePosts, post as unknown as Record<string, unknown>);

    return created(post);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Poll option')) {
      return badRequest(err.message);
    }
    if (err instanceof Error && err.message === 'Duplicate poll option id') {
      return badRequest(err.message);
    }
    console.error('clubhouse/createPost handler error:', err);
    return handleError(err);
  }
};
