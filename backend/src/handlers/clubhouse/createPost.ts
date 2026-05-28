import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { putItem, tableNames } from '../../lib/dynamodb';
import type {
  ClubhousePostItem,
  ClubhousePollOption,
  ClubhousePostType,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { lookupRecognition } from '../../lib/recognition';
import { resolveClubhouseMembership } from './_membership';
import { created, badRequest, forbidden, handleError } from '../_response';

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

    // ---- Membership gate ----
    // Same gate as `createComment.ts` — see `_membership.ts` for the
    // full policy. The Clubhouse is private to (a) the DRep's committee
    // and (b) wallets currently delegating to this DRep on-chain.
    //
    // **2026-05-28 change:** the original `createPost` was role-only
    // (requireRole on the JWT). A user reported they couldn't post in
    // their own delegated-DRep's clubhouse because they're not a
    // role-holder — the frontend gate had already been opened to
    // delegators in PR #7 (Batch E) but the backend never followed.
    // This unifies the two surfaces under the role-OR-delegator gate.
    const drepIdDecoded = decodeURIComponent(drepId);
    const membership = await resolveClubhouseMembership(
      authCtx.walletAddress,
      drepIdDecoded,
    );
    if (!membership.isRoleHolder && !membership.isCurrentDelegator) {
      if (!membership.delegationUnknown) {
        return forbidden(
          'You must be delegated to this DRep or be a committee member to post in their clubhouse',
        );
      }
      // Upstream couldn't be reached. Log and fall through to allow —
      // a transient Koios outage shouldn't 503 the surface for
      // legitimate delegators. Role-holders are unaffected (committee
      // lookup is a DDB Get, not an upstream call).
      console.warn(
        `createPost: allowing post from ${authCtx.walletAddress} despite unknown delegation (Koios+Blockfrost both failed)`,
      );
    }

    // `isDRepPost` distinguishes posts authored BY the DRep / their
    // committee from posts authored by delegators. Derived from the
    // committee row when one exists; defaults to false for pure
    // delegators (no committee role).
    const committee = membership.committee;
    const memberRecord = committee?.members.find(
      (m) => m.walletAddress === authCtx.walletAddress,
    );
    const isLeadOfThisCommittee = committee?.leadWallet === authCtx.walletAddress;
    const isDRepPost =
      Boolean(isLeadOfThisCommittee) ||
      memberRecord?.role === 'lead_drep' ||
      memberRecord?.role === 'committee_member';
    const now = new Date().toISOString();
    const postId = ulid();

    // Best-effort recognition lookup — same pattern as comments. The pill
    // stack on a clubhouse post mirrors the comment header (stake / DRep).
    const recognition = await lookupRecognition(authCtx.walletAddress);

    const post: ClubhousePostItem = {
      drepId: drepIdDecoded,
      postId,
      authorWallet: authCtx.walletAddress,
      isDRepPost,
      body: reqBody.body.trim(),
      comments: [],
      createdAt: now,
      updatedAt: now,
      type: postType,
      // P0-3 de-inline migration (2026-05-28): initialize the denormalized
      // counter so the `ADD :one` in `createComment.ts` starts from a
      // known-good zero. Without this, the first comment's `ADD` would
      // create the attribute lazily (DynamoDB treats missing as 0 for
      // `ADD`), but reads would have to default the field too. Setting it
      // explicitly here is cheaper than handling absence on every read.
      commentCount: 0,
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
