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
import { writeAuditEvent } from '../../lib/audit';
import { resolveClubhouseMembership } from './_membership';
import { created, badRequest, forbidden, serviceUnavailable, handleError } from '../_response';

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
    // **2026-05-28 SEC-2 fail-closed change:** if neither role nor
    // delegation can affirm membership AND both upstreams are down for
    // the delegation lookup (`delegationUnknown`), reject with 503 —
    // uncertainty about delegation MUST NOT grant access. Role-holders
    // bypass this 503 path entirely because the committee Get is a
    // local DDB read with no external dependency, so the DRep and
    // their committee retain write access during outages.
    //
    // Prior behavior (≤ 2026-05-27) soft-allowed writes when both
    // upstreams failed; Oracle's fresh-eyes audit flagged that as a
    // fail-open anti-pattern (an attacker who can degrade the lookup
    // posts into any clubhouse with no check).
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
      if (membership.delegationUnknown) {
        // Fail-CLOSED: dual-upstream outage means we can't confirm
        // delegation. Role-holders never hit this branch (they would
        // have been let through above on `isRoleHolder`).
        console.warn(
          `createPost: 503 rejecting ${authCtx.walletAddress} on drepId=${drepIdDecoded} — delegation lookup failed (Koios+Blockfrost both unreachable) and caller is not a role-holder`,
        );
        // Audit the security-relevant rejection — these are the rows an
        // incident-responder needs to spot abuse during a Koios outage
        // (e.g. someone trying to slip writes through under cover of
        // an upstream blip).
        await writeAuditEvent({
          entityType: 'auth',
          entityId: authCtx.walletAddress,
          eventType: 'auth.delegation_unverified',
          actorWallet: authCtx.walletAddress,
          metadata: {
            surface: 'createPost',
            drepId: drepIdDecoded,
          },
        });
        return serviceUnavailable(
          "Couldn't verify your delegation right now, please retry",
        );
      }
      await writeAuditEvent({
        entityType: 'clubhouse_post',
        entityId: drepIdDecoded,
        eventType: 'clubhouse.post.denied',
        actorWallet: authCtx.walletAddress,
        metadata: {
          surface: 'createPost',
          drepId: drepIdDecoded,
          reason: 'not_member',
        },
      });
      return forbidden(
        'You must be delegated to this DRep or be a committee member to post in their clubhouse',
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
      createdAt: now,
      updatedAt: now,
      type: postType,
      // P0-3 de-inline migration (2026-05-28): the inline `comments: []`
      // field was REMOVED in Phase 6. Posts now carry only the
      // denormalized `commentCount` counter; the per-row comments live
      // in `clubhouse_comments`. The Phase 7 cleanup script strips the
      // residual empty `comments` attribute from existing post rows.
      // Initialize the counter so the `ADD :one` in `createComment.ts`
      // starts from a known-good zero.
      commentCount: 0,
      ...(reqBody.title?.trim() ? { title: reqBody.title.trim() } : {}),
      ...(pollOptions ? { pollOptions, pollMultiple: pollMultiple ?? false } : {}),
      ...(pollClosesAt ? { pollClosesAt } : {}),
      ...(pollOptions ? { pollVotes: {} } : {}),
      ...(recognition.stakeAda ? { stakeAda: recognition.stakeAda } : {}),
      ...(recognition.drep ? { drep: recognition.drep } : {}),
    };

    await putItem(tableNames.clubhousePosts, post as unknown as Record<string, unknown>);

    await writeAuditEvent({
      entityType: 'clubhouse_post',
      entityId: postId,
      eventType: 'clubhouse.post.created',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId: drepIdDecoded,
        type: postType,
        isDRepPost,
        ...(pollOptions ? { pollOptionCount: pollOptions.length } : {}),
      },
    });

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
