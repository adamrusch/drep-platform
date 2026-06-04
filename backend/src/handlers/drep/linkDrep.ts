import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, updateItem, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { drepIdFromDRepKey } from '../../lib/drepId';
import {
  buildDRepLinkMessage,
  validateDRepLinkNonce,
  verifyDRepKeySignature,
} from '../../lib/auth';
import { ok, badRequest, unauthorized, conflict, notFound, handleError } from '../_response';

interface LinkDrepBody {
  /** CIP-95 DRep public key (hex). What `cip95.getPubDRepKey()` returned. */
  drepKey?: string;
  /** The nonce issued by POST /drep/link/challenge for this drepKey. */
  nonce?: string;
  /** COSE_Sign1 hex from `cip95.signData(<drepId>, <message-as-hex>)`. */
  signature?: string;
  /** COSE_Key hex from the same `cip95.signData` return. */
  key?: string;
}

/**
 * POST /drep/link
 *
 * Link the caller's wallet to their on-chain DRep, so they're recognized as
 * a DRep across the platform (profile, clubhouse names) WITHOUT needing a
 * committee. Sets `users.drepId`.
 *
 * # Security (the whole point of this handler)
 *
 * The DRep public key is on-chain public information. Knowing it does NOT
 * prove the caller controls the corresponding private key — and a DRep
 * binding is sensitive (it grants the caller "is this on-chain DRep"
 * status throughout the platform and may bind to committee membership).
 * To link, the caller must:
 *
 *   1. Have called POST /drep/link/challenge with the same `drepKey` and
 *      obtained a `nonce` + `message`. (The message embeds the wallet
 *      address AND the drep id derived from drepKey — see
 *      `buildDRepLinkMessage`.)
 *   2. Sign that message with the CIP-95 DRep key via `cip95.signData`,
 *      returning a COSE_Sign1 `{signature, key}`.
 *   3. POST `{drepKey, nonce, signature, key}` here.
 *
 * This handler then:
 *
 *   a. Atomically consumes the nonce bound to the caller's wallet.
 *   b. Reconstructs the EXACT message from { walletAddress, drepId, nonce }
 *      — issuer and verifier share `buildDRepLinkMessage`.
 *   c. Runs `verifyDRepKeySignature`, which:
 *        - decodes COSE_Sign1 and confirms the payload equals the
 *          reconstructed message,
 *        - extracts the Ed25519 pubkey from the COSE_Key,
 *        - confirms the pubkey hashes (blake2b-224) to the same
 *          credential as `drepKey` — i.e. the SIGNING key IS the
 *          claimed DRep key,
 *        - Ed25519-verifies the Sig_Structure.
 *      That binding is the load-bearing security check: without it,
 *      an attacker could sign a victim-addressed message with their OWN
 *      DRep key and present the resulting COSE_Sign1 alongside the
 *      victim's drepKey in the body. The pubkey↔drepKey hash check kills
 *      that swap.
 *   d. Confirms the drep id is in the on-chain directory.
 *   e. Writes users.drepId.
 *
 * # No paste path. No stage gating. No silent auto-link.
 *
 * The previous "paste a drep id" and "derive from drepKey alone" paths
 * proved only that the DRep exists, not that the caller controlled it —
 * they were gated to non-prod via a stage helper. With this rewrite the
 * proof-of-control path is the ONLY path, on all stages.
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

    const drepKey = body.drepKey?.trim();
    const nonce = body.nonce?.trim();
    const signature = body.signature?.trim();
    const key = body.key?.trim();

    if (!drepKey || !nonce || !signature || !key) {
      return badRequest('drepKey, nonce, signature, and key are all required');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(drepKey)) {
      return badRequest('drepKey must be a 32-byte hex Ed25519 public key');
    }

    let drepId: string;
    try {
      drepId = drepIdFromDRepKey(drepKey);
    } catch {
      return badRequest('Invalid CIP-95 DRep key');
    }

    // Consume the nonce BEFORE signature verification. Distinct-kind nonces
    // (`drep_link` vs `mutation` / `challenge`) mean a stolen mutation
    // nonce can never satisfy this check. If the consume succeeds the
    // nonce is gone — replays die here.
    const nonceResult = await validateDRepLinkNonce(nonce, authCtx.walletAddress);
    if (!nonceResult.valid) {
      return unauthorized(nonceResult.reason ?? 'Invalid DRep-link nonce');
    }

    // Reconstruct the EXACT message the wallet signed. Issuer + verifier
    // share `buildDRepLinkMessage` so the bytes match.
    const message = buildDRepLinkMessage(nonce, authCtx.walletAddress, drepId);

    const sigResult = verifyDRepKeySignature(drepKey, message, { signature, key });
    if (!sigResult.valid) {
      return unauthorized(sigResult.reason ?? 'Invalid DRep-key signature');
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
      metadata: { drepId, linkedVia: 'cip95-proof-of-control' },
    });

    return ok({ drepId, drepName: dir.givenName });
  } catch (err) {
    console.error('drep/linkDrep error:', err);
    return handleError(err);
  }
};
