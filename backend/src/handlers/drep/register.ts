import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { getItem, transactWrite, tableNames } from '../../lib/dynamodb';
import type {
  DRepCommitteeItem,
  CommitteeMemberItem,
  CommitteeMembershipItem,
  UserItem,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import {
  getSafetyMode,
  isSafetyModeActive,
  isNewWallet,
  maybeTripSafetyMode,
} from '../../lib/safetyMode';
import { created, badRequest, conflict, forbidden, handleError } from '../_response';

interface RegisterDRepBody {
  committeeName: string;
  description: string;
  onChainMetadata?: Record<string, unknown>;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    if (!event.body) {
      return badRequest('Request body is required');
    }

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

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    // ---- Sybil safety-mode gate ----
    // While the platform is latched into safety mode (>5 committees created in
    // a trailing 12h, see lib/safetyMode.ts), a wallet whose first auth was
    // under 7 days ago cannot create a committee. Established wallets pass.
    const safety = await getSafetyMode();
    if (isSafetyModeActive(safety, Math.floor(nowMs / 1000))) {
      const profile = await getItem<UserItem>(tableNames.users, {
        walletAddress: authCtx.walletAddress,
        SK: 'PROFILE',
      });
      if (isNewWallet(profile?.createdAt, nowMs)) {
        return forbidden(
          'The platform is temporarily in safety mode after a spike in new committees. ' +
            'Wallets newer than 7 days cannot create a committee right now. Please try again later.',
        );
      }
    }

    const drepId = ulid();

    const leadMember: CommitteeMemberItem = {
      walletAddress: authCtx.walletAddress,
      joinedAt: now,
      role: 'lead_drep',
    };

    const committee: DRepCommitteeItem = {
      drepId,
      SK: 'COMMITTEE',
      leadWallet: authCtx.walletAddress,
      committeeName: body.committeeName.trim(),
      description: body.description.trim(),
      onChainMetadata: body.onChainMetadata,
      members: [leadMember],
      createdAt: now,
      updatedAt: now,
    };

    const membershipRow: CommitteeMembershipItem = {
      walletAddress: authCtx.walletAddress,
      drepId,
      role: 'lead',
      joinedAt: now,
    };

    const rolesSet = new Set([...authCtx.roles, 'lead_drep']);

    // Atomic: create the committee, claim the lead's single membership slot
    // (fails if this wallet already belongs to ANY committee — lead or member),
    // and elevate the user's role — all-or-nothing. The membership row is the
    // authoritative "one committee per wallet, total" guard (replacing the
    // earlier leadWallet-index pre-check, which couldn't see membership on
    // someone else's committee).
    try {
      await transactWrite([
        {
          Put: {
            TableName: tableNames.drepCommittees,
            Item: committee as unknown as Record<string, unknown>,
          },
        },
        {
          Put: {
            TableName: tableNames.committeeMembership,
            Item: membershipRow as unknown as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(walletAddress)',
          },
        },
        {
          Update: {
            TableName: tableNames.users,
            Key: { walletAddress: authCtx.walletAddress, SK: 'PROFILE' },
            UpdateExpression: 'SET #roles = :roles, #drepId = :drepId, #updatedAt = :now',
            ExpressionAttributeNames: { '#roles': 'roles', '#drepId': 'drepId', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':roles': Array.from(rolesSet), ':drepId': drepId, ':now': now },
          },
        },
      ]);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict('This wallet already belongs to a DRep committee');
      }
      throw err;
    }

    // Best-effort: a successful creation may push the trailing-12h count over
    // the threshold and latch safety mode. Never fails the registration.
    try {
      await maybeTripSafetyMode(nowMs);
    } catch (err) {
      console.error('register: maybeTripSafetyMode failed (non-fatal):', err);
    }

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'drep.committee.registered',
      actorWallet: authCtx.walletAddress,
      metadata: { leadWallet: authCtx.walletAddress },
    });

    return created(committee);
  } catch (err) {
    console.error('drep/register handler error:', err);
    return handleError(err);
  }
};
