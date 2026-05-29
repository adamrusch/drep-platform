import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  peekChallenge,
  consumeChallenge,
  verifyWalletSignature,
  issueJWT,
  buildSignMessage,
  buildSetCookieHeader,
  hashValue,
} from '../../lib/auth';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import { _invalidateForStake } from '../../lib/recognition';
import { writeAuditEvent } from '../../lib/audit';
import type { UserItem, SessionType } from '../../lib/types';
import { ok, badRequest, unauthorized, internalError } from '../_response';

interface VerifyRequestBody {
  walletAddress: string;
  nonce: string;
  signature: string;
  key: string;
  rememberMe?: boolean;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: VerifyRequestBody;
    try {
      body = JSON.parse(event.body) as VerifyRequestBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const { walletAddress, nonce, signature, key } = body;

    if (!walletAddress || !nonce || !signature || !key) {
      return badRequest('walletAddress, nonce, signature, and key are required');
    }

    // 1. Peek the nonce — confirm it exists, is unexpired, and matches the
    //    wallet — but DO NOT consume it yet. Consuming before signature
    //    verification would let an attacker burn a victim's freshly-issued
    //    nonce by submitting a bogus signature.
    const peek = await peekChallenge(nonce, walletAddress);
    if (!peek.valid) {
      return unauthorized(peek.reason ?? 'Invalid challenge');
    }

    // 2. Verify the wallet signature against the expected message.
    const expectedMessage = buildSignMessage(nonce, walletAddress);
    const sigResult = verifyWalletSignature(walletAddress, expectedMessage, { signature, key });
    if (!sigResult.valid) {
      return unauthorized(sigResult.reason ?? 'Invalid signature');
    }

    // 3. Atomically consume the nonce. If two requests with valid signatures
    //    race for the same nonce, only one wins; the other gets 401.
    const consume = await consumeChallenge(nonce);
    if (!consume.valid) {
      return unauthorized(consume.reason ?? 'Challenge already consumed');
    }

    // 3. Upsert user record in DynamoDB
    const now = new Date().toISOString();
    const sessionType: SessionType = body.rememberMe ? 'remember_me' : 'normal';

    // Fetch existing user to preserve roles/profile
    const existing = await getItem<UserItem>(tableNames.users, {
      walletAddress,
      SK: 'PROFILE',
    });

    const sessionExpiry = new Date(
      Date.now() + (sessionType === 'remember_me' ? 30 : 7) * 24 * 60 * 60 * 1000,
    ).toISOString();

    // 4. Issue JWT
    const roles = existing?.roles as string[] | undefined;
    const typedRoles = (roles ?? ['delegator']) as Array<'guest' | 'delegator' | 'committee_member' | 'lead_drep' | 'trusted_delegator'>;
    const { token, expiresAt } = await issueJWT(walletAddress, typedRoles, sessionType, existing?.drepId as string | undefined);

    const userItem: UserItem = {
      walletAddress,
      SK: 'PROFILE',
      displayName: existing?.displayName,
      bio: existing?.bio,
      socialLinks: existing?.socialLinks,
      roles: typedRoles,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sessionTokenHash: hashValue(token),
      sessionExpiry,
      delegationHistory: existing?.delegationHistory,
    };

    await putItem(tableNames.users, userItem as unknown as Record<string, unknown>);

    // Bust the recognition LRU for this stake (this-container only). A
    // user who re-delegated between two sign-ins would otherwise see the
    // OLD DRep's clubhouse routing for up to 60s. Per-container scope is
    // documented on `_invalidateForStake`; other containers will catch
    // up within their own TTL window. Best-effort — never fail the
    // verify on a cache-eviction error.
    try {
      _invalidateForStake(walletAddress);
    } catch (err) {
      console.warn('verify: recognition cache eviction failed (non-fatal):', err);
    }

    // Best-effort audit AFTER the user-row write succeeds. The actor
    // and entity are both the verified wallet — `auth.login` events
    // colocate per-wallet so `Query(pk='auth#stake1...')` yields a
    // login timeline for incident review.
    await writeAuditEvent({
      entityType: 'auth',
      entityId: walletAddress,
      eventType: 'auth.login',
      actorWallet: walletAddress,
      metadata: {
        sessionType,
        rolesAtIssue: typedRoles,
        isNewUser: existing === undefined,
      },
    });

    const cookieHeader = buildSetCookieHeader(token, sessionType);

    return ok(
      {
        walletAddress,
        roles: typedRoles,
        sessionType,
        expiresAt,
      },
      [cookieHeader],
    );
  } catch (err) {
    console.error('verify handler error:', err);
    return internalError('Authentication failed');
  }
};
