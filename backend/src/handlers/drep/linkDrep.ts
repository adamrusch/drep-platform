import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, updateItem, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { drepIdFromDRepKey } from '../../lib/drepId';
import { ok, badRequest, conflict, notFound, handleError } from '../_response';

interface LinkDrepBody {
  /** CIP-95 DRep public key (hex) — derived server-side, proves control. */
  drepKey?: string;
  /** Or a pasted drep id — verified registered, but does NOT prove control. */
  drepId?: string;
}

/**
 * Link the caller's wallet to their on-chain DRep, so they're recognized as a
 * DRep across the platform (profile, clubhouse names) WITHOUT needing a
 * committee. Sets users.drepId. Two paths:
 *   - drepKey (CIP-95): derived + proves the caller controls the DRep.
 *   - drepId (paste): verified to be registered on-chain (testing convenience;
 *     does not prove control — prefer drepKey to prevent impersonation).
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    if (!event.body) return badRequest('Request body is required');

    let body: LinkDrepBody;
    try {
      body = JSON.parse(event.body) as LinkDrepBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

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
      return badRequest('Provide your CIP-95 DRep key (drepKey) or your registered drep id (drepId).');
    }

    // Must be a registered DRep on-chain (present in the synced directory).
    const dir = await getItem<{ givenName?: string }>(tableNames.drepDirectory, {
      drepId,
      SK: 'PROFILE',
    });
    if (!dir) {
      return conflict(
        'That DRep is not in the on-chain directory yet. Make sure your DRep is registered — newly-registered DReps can take a few minutes to index.',
      );
    }

    const now = new Date().toISOString();
    try {
      await updateItem(
        tableNames.users,
        { walletAddress: authCtx.walletAddress, SK: 'PROFILE' },
        'SET drepId = :drepId, #updatedAt = :now',
        { '#updatedAt': 'updatedAt' },
        { ':drepId': drepId, ':now': now },
        'attribute_exists(walletAddress)',
      );
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return notFound('User profile');
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'user',
      entityId: authCtx.walletAddress,
      eventType: 'drep.linked',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, linkedVia: body.drepKey ? 'cip95' : 'drepId' },
    });

    return ok({ drepId, drepName: dir.givenName });
  } catch (err) {
    console.error('drep/linkDrep error:', err);
    return handleError(err);
  }
};
