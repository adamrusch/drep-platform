import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, transactWrite, tableNames } from '../../lib/dynamodb';
import type {
  DRepCommitteeItem,
  CommitteeMemberItem,
  CommitteeMembershipItem,
  UserItem,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { drepIdFromDRepKey } from '../../lib/drepId';
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
  /** Proof-of-control path: the CIP-95 DRep public key (hex). The backend
   *  derives the drep id from it, so only a wallet that controls the DRep can
   *  bind a committee to it. Preferred. */
  drepKey?: string;
  /** Fallback path: the caller's registered drep id (drep1…). Verified to be a
   *  registered DRep on-chain, but does NOT prove control — kept for testing /
   *  wallets without CIP-95; harden with drepKey for production. */
  drepId?: string;
}

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

    // ---- Resolve the real on-chain DRep id ----
    // The committee is keyed by the lead's actual drep id, so the committee can
    // govern that DRep's on-chain votes. Two ways to supply it:
    //   - drepKey (CIP-95): derived server-side → proves control.
    //   - drepId (paste): verified to be registered on-chain (below).
    let drepId: string;
    if (body.drepKey) {
      try {
        drepId = drepIdFromDRepKey(body.drepKey.trim());
      } catch {
        return badRequest('Invalid CIP-95 DRep key');
      }
    } else if (body.drepId && /^drep1[0-9a-z]{10,}$/.test(body.drepId.trim())) {
      drepId = body.drepId.trim();
    } else {
      return badRequest(
        'A DRep is required. Connect a CIP-95 wallet (we read your DRep key) or provide your registered drep id.',
      );
    }

    // The DRep must actually be registered on-chain. We check the platform's
    // directory (synced from chain); a brand-new DRep can take a few minutes to
    // appear there after its registration confirms.
    const drepInDirectory = await getItem(tableNames.drepDirectory, { drepId, SK: 'PROFILE' });
    if (!drepInDirectory) {
      return conflict(
        'That DRep is not in the on-chain directory yet. Make sure your DRep is registered on-chain — newly-registered DReps can take a few minutes to index.',
      );
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    // ---- Sybil safety-mode gate ----
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

    // Atomic: create the committee (one per DRep — conditional on the COMMITTEE
    // row not existing), claim the lead's single membership slot (one committee
    // per wallet, total), and elevate the user's role + link the drep id.
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
        return conflict('This DRep already has a committee, or your wallet already belongs to one.');
      }
      throw err;
    }

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
      metadata: { leadWallet: authCtx.walletAddress, drepId, boundVia: body.drepKey ? 'cip95' : 'drepId' },
    });

    return created(committee);
  } catch (err) {
    console.error('drep/register handler error:', err);
    return handleError(err);
  }
};
