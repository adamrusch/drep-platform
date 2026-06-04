import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, batchGetItems, transactWrite, tableNames } from '../../lib/dynamodb';
import type {
  DRepCommitteeItem,
  CommitteeMemberItem,
  CommitteeMembershipItem,
  CommitteeInviteItem,
  UserItem,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { normalizeToStakeAddress } from '../../lib/cardanoAddress';
import {
  getSafetyMode,
  isSafetyModeActive,
  isNewWallet,
  maybeTripSafetyMode,
} from '../../lib/safetyMode';
import { MIN_COMMITTEE_MEMBERS, inviteSk } from '../committee/_committee';
import { created, badRequest, conflict, forbidden, handleError } from '../_response';

interface RegisterDRepBody {
  committeeName: string;
  description: string;
  onChainMetadata?: Record<string, unknown>;
  /** Addresses (payment OR stake form) of the OTHER members — the Chair (the
   *  caller) is auto-included as member #1, so this need not contain them. */
  members?: string[];
  /** X in "X of N": how many members must vote Agree for "Committee Approved". */
  approvalThreshold: number;
}

/** Hard cap so the formation transactWrite stays well under DynamoDB's 100-item
 *  limit (1 committee + 1 chair membership + others + 1 user update). */
const MAX_OTHER_MEMBERS = 50;

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    if (!event.body) return badRequest('Request body is required');

    let body: RegisterDRepBody;
    try {
      body = JSON.parse(event.body) as RegisterDRepBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!body.committeeName || body.committeeName.trim().length === 0) {
      return badRequest('committeeName is required');
    }
    if (!body.description || body.description.trim().length === 0) {
      return badRequest('description is required');
    }

    // ---- Gate: the caller must already be a registered DRep ----
    // The committee binds to the DRep the caller linked (via /drep/link, which
    // proves control in prod). No drep id is accepted here — we read it off the
    // caller's profile, so a committee can only ever bind to YOUR own DRep.
    const profile = await getItem<UserItem>(tableNames.users, {
      walletAddress: authCtx.walletAddress,
      SK: 'PROFILE',
    });
    const drepId = profile?.drepId as string | undefined;
    if (!drepId) {
      return forbidden(
        'You must be a registered DRep to form a committee. Link your DRep on your profile first.',
      );
    }
    const drepInDirectory = await getItem(tableNames.drepDirectory, { drepId, SK: 'PROFILE' });
    if (!drepInDirectory) {
      return conflict(
        'Your DRep is not in the on-chain directory yet. Newly-registered DReps can take a few minutes to index — try again shortly.',
      );
    }

    // ---- Resolve + validate the member roster ----
    // authCtx.walletAddress is already the canonical stake identity (normalised
    // at /auth/verify); normalise again defensively so the Chair self-exclusion
    // + dedup below always compare canonical forms.
    const chairStake = normalizeToStakeAddress(authCtx.walletAddress) ?? authCtx.walletAddress;
    const rawOthers = Array.isArray(body.members) ? body.members : [];
    if (rawOthers.length > MAX_OTHER_MEMBERS) {
      return badRequest(`A committee can have at most ${MAX_OTHER_MEMBERS + 1} members.`);
    }

    const invalid: string[] = [];
    const otherStakes = new Set<string>();
    for (const raw of rawOthers) {
      const input = (raw ?? '').trim();
      if (!input) continue;
      const stake = normalizeToStakeAddress(input);
      if (!stake) {
        invalid.push(input);
        continue;
      }
      if (stake === chairStake) continue; // chair is auto-included; ignore self
      otherStakes.add(stake);
    }
    if (invalid.length > 0) {
      return badRequest(
        `These addresses aren't valid Cardano payment or stake addresses: ${invalid
          .slice(0, 5)
          .join(', ')}${invalid.length > 5 ? '…' : ''}`,
      );
    }

    // The Chair's INTENDED committee size: Chair (1) + every invited address
    // (regardless of accept/decline). Under decision B this is the bound on X.
    const intendedN = 1 + otherStakes.size;
    if (intendedN < MIN_COMMITTEE_MEMBERS) {
      return badRequest(
        `A committee needs at least ${MIN_COMMITTEE_MEMBERS} members. You (the Chair) plus ${
          MIN_COMMITTEE_MEMBERS - 1
        } more — add ${MIN_COMMITTEE_MEMBERS - intendedN} more address(es).`,
      );
    }

    // ---- Validate X of intendedN ----
    const X = body.approvalThreshold;
    if (typeof X !== 'number' || !Number.isInteger(X) || X < 1 || X > intendedN) {
      return badRequest(
        `approvalThreshold (X) must be a whole number between 1 and ${intendedN} (the intended committee size).`,
      );
    }

    // ---- Read invitee user rows: needed for both the "active" badge and
    // the `autoDeclineInvites` honoring path. One batched read covers both. ----
    const others = [...otherStakes];
    const userRows =
      others.length > 0
        ? await batchGetItems<UserItem>(
            tableNames.users,
            others.map((s) => ({ walletAddress: s, SK: 'PROFILE' })),
          )
        : [];
    const activeSet = new Set(userRows.map((r) => r.walletAddress));
    const autoDeclineSet = new Set(
      userRows
        .filter((r) => r.autoDeclineInvites === true)
        .map((r) => r.walletAddress),
    );

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    // ---- Sybil safety-mode gate ----
    const safety = await getSafetyMode();
    if (isSafetyModeActive(safety, Math.floor(nowMs / 1000)) && isNewWallet(profile?.createdAt, nowMs)) {
      return forbidden(
        'The platform is temporarily in safety mode after a spike in new committees. ' +
          'Wallets newer than 7 days cannot create a committee right now. Please try again later.',
      );
    }

    // The Chair is added directly to `members[]` (they form the committee —
    // they're already a member). Every OTHER address becomes an INVITE row
    // — pending unless the invitee has `autoDeclineInvites=true`, in which
    // case the invite is auto-rejected and no membership slot is claimed.
    const members: CommitteeMemberItem[] = [
      { walletAddress: chairStake, joinedAt: now, role: 'lead_drep', active: true },
    ];

    // `intendedMemberCount` = 1 (Chair) + every invited address (regardless of
    // autoDecline status). The Chair's intended N is what they typed into the
    // formation wizard — the validator must enforce X ≤ intendedN.
    const intendedMemberCount = 1 + others.length;

    const committee: DRepCommitteeItem = {
      drepId,
      SK: 'COMMITTEE',
      leadWallet: chairStake,
      committeeName: body.committeeName.trim(),
      description: body.description.trim(),
      onChainMetadata: body.onChainMetadata,
      members,
      approvalThreshold: X,
      intendedMemberCount,
      createdAt: now,
      updatedAt: now,
    };

    // Chair's own membership slot — always claimed.
    const chairMembership: CommitteeMembershipItem = {
      walletAddress: chairStake,
      drepId,
      role: 'lead',
      joinedAt: now,
    };

    // Build the per-invitee TransactItems. Two cases per invitee:
    //   - autoDecline=true → write an INVITE row with status='rejected'
    //                        ONLY. Skip the membership slot claim (frees
    //                        the wallet to participate elsewhere later).
    //   - autoDecline=false → write a pending INVITE row AND claim the
    //                        membership slot with role='invited'.
    const inviteItems: Array<Record<string, unknown>> = [];
    const slotItems: Array<Record<string, unknown>> = [];
    let autoDeclinedCount = 0;
    for (const inviteeStake of others) {
      const isAutoDecline = autoDeclineSet.has(inviteeStake);
      const invite: CommitteeInviteItem = {
        drepId,
        SK: inviteSk(inviteeStake),
        inviteeStake,
        status: isAutoDecline ? 'rejected' : 'pending',
        role: 'committee_member',
        invitedBy: chairStake,
        invitedAt: now,
        ...(isAutoDecline ? { respondedAt: now } : {}),
      };
      inviteItems.push({
        Put: {
          TableName: tableNames.drepCommittees,
          Item: invite as unknown as Record<string, unknown>,
          ConditionExpression: 'attribute_not_exists(drepId) AND attribute_not_exists(SK)',
        },
      });
      if (isAutoDecline) {
        autoDeclinedCount++;
        continue;
      }
      const slot: CommitteeMembershipItem = {
        walletAddress: inviteeStake,
        drepId,
        role: 'invited',
        joinedAt: now,
      };
      slotItems.push({
        Put: {
          TableName: tableNames.committeeMembership,
          Item: slot as unknown as Record<string, unknown>,
          ConditionExpression: 'attribute_not_exists(walletAddress)',
        },
      });
    }

    const rolesSet = new Set([...authCtx.roles, 'lead_drep']);

    try {
      await transactWrite([
        {
          Put: {
            TableName: tableNames.drepCommittees,
            Item: committee as unknown as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(drepId)',
          },
        },
        {
          Put: {
            TableName: tableNames.committeeMembership,
            Item: chairMembership as unknown as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(walletAddress)',
          },
        },
        ...inviteItems,
        ...slotItems,
        {
          Update: {
            TableName: tableNames.users,
            Key: { walletAddress: chairStake, SK: 'PROFILE' },
            UpdateExpression: 'SET #roles = :roles, #updatedAt = :now',
            ExpressionAttributeNames: { '#roles': 'roles', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':roles': Array.from(rolesSet), ':now': now },
          },
        },
      ]);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict(
          'Could not create the committee: your DRep already has one, or one of the addresses you added already belongs to another committee.',
        );
      }
      throw err;
    }

    try {
      await maybeTripSafetyMode(nowMs);
    } catch (err) {
      console.error('register: maybeTripSafetyMode failed (non-fatal):', err);
    }

    const invitedCount = others.length - autoDeclinedCount;
    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'drep.committee.registered',
      actorWallet: chairStake,
      metadata: {
        leadWallet: chairStake,
        drepId,
        intendedMemberCount,
        invitedCount,
        autoDeclinedCount,
        approvalThreshold: X,
      },
    });

    // Surface invitation counts so the formation UI can confirm
    // "3 invited, 1 auto-declined" without a follow-up read.
    return created({
      ...committee,
      _activeUserCount: activeSet.size, // diagnostic — informational for the wizard
      invitedCount,
      autoDeclinedCount,
    });
  } catch (err) {
    console.error('drep/register handler error:', err);
    return handleError(err);
  }
};
