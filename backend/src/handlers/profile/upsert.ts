import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import type { UserItem, SocialLinks } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { ok, badRequest, internalError, handleError } from '../_response';

interface UpsertProfileBody {
  displayName?: string;
  bio?: string;
  socialLinks?: SocialLinks;
  /** When true, future committee invitations are auto-rejected at creation
   *  (no membership slot claimed). Does NOT touch existing pending invites
   *  — use POST /me/invitations/decline-all for that. Setting to `false`
   *  reverts to normal behavior; omitting the field leaves the prior value
   *  unchanged. */
  autoDeclineInvites?: boolean;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: UpsertProfileBody;
    try {
      body = JSON.parse(event.body) as UpsertProfileBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
        return badRequest('displayName must be a non-empty string');
      }
      if (body.displayName.length > 100) {
        return badRequest('displayName exceeds maximum length of 100 characters');
      }
    }

    if (body.bio !== undefined && body.bio.length > 2_000) {
      return badRequest('bio exceeds maximum length of 2,000 characters');
    }

    if (body.autoDeclineInvites !== undefined && typeof body.autoDeclineInvites !== 'boolean') {
      return badRequest('autoDeclineInvites must be a boolean');
    }

    const now = new Date().toISOString();
    const existing = await getItem<UserItem>(tableNames.users, {
      walletAddress: authCtx.walletAddress,
      SK: 'PROFILE',
    });

    const updated: UserItem = {
      walletAddress: authCtx.walletAddress,
      SK: 'PROFILE',
      displayName: body.displayName?.trim() ?? existing?.displayName,
      bio: body.bio ?? existing?.bio,
      socialLinks: body.socialLinks ?? existing?.socialLinks,
      roles: existing?.roles ?? ['delegator'],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sessionTokenHash: existing?.sessionTokenHash,
      sessionExpiry: existing?.sessionExpiry,
      delegationHistory: existing?.delegationHistory,
      // Persist the new flag explicitly so a `false` from the FE correctly
      // overrides a stored `true` (the spread-fallback would have lost it).
      ...(body.autoDeclineInvites !== undefined
        ? { autoDeclineInvites: body.autoDeclineInvites }
        : existing?.autoDeclineInvites !== undefined
          ? { autoDeclineInvites: existing.autoDeclineInvites }
          : {}),
    };

    await putItem(tableNames.users, updated);

    // Best-effort audit AFTER the user-row write succeeds. Metadata
    // captures WHICH fields were touched (not their values — that's
    // PII territory).
    await writeAuditEvent({
      entityType: 'user_profile',
      entityId: authCtx.walletAddress,
      eventType: 'profile.updated',
      actorWallet: authCtx.walletAddress,
      metadata: {
        isNewProfile: existing === undefined,
        fieldsSet: [
          ...(body.displayName !== undefined ? ['displayName'] : []),
          ...(body.bio !== undefined ? ['bio'] : []),
          ...(body.socialLinks !== undefined ? ['socialLinks'] : []),
          ...(body.autoDeclineInvites !== undefined ? ['autoDeclineInvites'] : []),
        ],
      },
    });

    const {
      sessionTokenHash: _s,
      sessionExpiry: _e,
      ...publicProfile
    } = updated;

    return ok(publicProfile);
  } catch (err) {
    console.error('profile/upsert handler error:', err);
    return handleError(err);
  }
};
