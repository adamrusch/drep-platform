/**
 * Decision #3 (2026-06-10) — canonical "person" + identity-link store.
 *
 * One individual is recognised as the same person whether they log in
 * via a CIP-30 wallet (proves control of a stake credential) or a
 * raw-key on-chain login (SPO Calidus / CC hot key / DRep CIP-8). This
 * module owns the small set of helpers every caller (login, link
 * flow, `me` aggregation, profile get/update) uses to read and write
 * the two new tables:
 *
 *   - `onchain_users` (PK=`personId`) — the editable profile.
 *   - `identity_links` (PK=`identityKey`) — maps each on-chain
 *     credential to a `personId`. GSI `personId-verifiedAt-index`
 *     lets the `/auth/onchain/me` aggregation enumerate every
 *     credential a person controls in a single-partition Query.
 *
 * # Identity key shape
 *
 * The PK on `identity_links` is a NAMESPACED credential string:
 *
 *     `drep:<drepId>`     — bech32 `drep1...`
 *     `pool:<poolId>`     — bech32 `pool1...`
 *     `cc:<ccCred>`       — bech32 `cc_cold1...` (preferred) or
 *                           `cc_hot1...` fallback
 *     `stake:<stakeAddr>` — bech32 `stake1...` / `stake_test1...`
 *
 * The prefix is load-bearing — without it, a CC cold id and a DRep id
 * that happen to share a bech32 style could collide (different
 * credential types, same string). The prefix also lets a credential
 * type be re-derived on read without re-decoding the bech32 hull.
 *
 * # Reconciliation semantics (the load-bearing contract)
 *
 * On a fresh on-chain login (`onchainVerify`):
 *
 *   - `resolveOrProvisionPerson(identityKey, role)`:
 *     - If a row exists at PK=`identityKey`: return its `personId`.
 *     - Otherwise: mint a new `personId` (ULID), write the person row,
 *       write the identity_links row at PK=`identityKey` with
 *       `verifiedVia='login'`. Return the new `personId`.
 *
 * On an explicit credential link (`/auth/onchain/link/verify` —
 * caller is ALREADY signed in with one credential and is proving
 * control of a SECOND):
 *
 *   - `linkCredentialToPerson(identityKey, personId, role)`:
 *     - If a row exists at PK=`identityKey` with the SAME `personId`:
 *       idempotent success (already linked).
 *     - If a row exists at PK=`identityKey` with a DIFFERENT `personId`:
 *       REJECT — "credential already linked to another account".
 *       Account merge is a future product decision; we never silently
 *       collapse two persons.
 *     - Otherwise: write the identity_links row with `verifiedVia='link'`.
 *
 * The "different person" rejection above is the SAFETY guarantee
 * Decision #3 requires.
 *
 * # Where Decision #2 will complete the picture
 *
 * Decision #2 (a future PR) cuts the LEGACY CIP-30 wallet login over
 * to the identity module, so a wallet login can publish a
 * `stake:<addr>` credential into this system automatically. Today, a
 * wallet user who explicitly LINKS their wallet (via the link flow,
 * signing with the wallet) is the bridge that works — they sign in
 * via the on-chain path first (as DRep / SPO / CC / Proposer), then
 * link their wallet stake address via the link flow. Decision #2 will
 * make that automatic for the wallet-login path.
 *
 * # Forward-compat notes
 *
 *   - The `proposer` on-chain role maps to a `stake` credential
 *     (proposers prove control of a stake address). A user who logged
 *     in as both `drep` and `proposer` from the SAME wallet will
 *     therefore have TWO identity_links rows (one `drep:`, one
 *     `stake:`) auto-mapped to the same person via the login
 *     reconciliation — every fresh `proposer` login presents a
 *     stake-credential key.
 *
 *   - `listPersonCredentials` returns the projection ALL from the GSI,
 *     so the `me` aggregation reads the full row set in one round-
 *     trip — no second BatchGet on the person row.
 */
import { ulid } from 'ulid';
import {
  getItem,
  putItem,
  putItemIfAbsent,
  queryItems,
  tableNames,
} from './dynamodb';
import type {
  IdentityCredentialType,
  IdentityLinkItem,
  IdentityLinkOrigin,
  OnchainUserItem,
  OnChainRole,
  SocialLinks,
} from './types';

// ---------------------------------------------------------------------------
// Identity key composition (the namespacing contract)
// ---------------------------------------------------------------------------

/** Compose a namespaced identity key from a credential type and id.
 *  This is the only place in the codebase that constructs the
 *  `identityKey` PK — every caller (login reconciliation, link flow,
 *  `me` aggregation) MUST route through this helper so the shape can
 *  never drift across writers and readers. */
export function identityKeyFor(type: IdentityCredentialType, id: string): string {
  if (!id) {
    throw new Error('identityKeyFor: credential id is required');
  }
  return `${type}:${id}`;
}

/** Map an on-chain role to its credential type. Proposer credentials
 *  are stake addresses (proposers prove control of a stake key), so
 *  `proposer → 'stake'`. The other three roles map 1:1.
 *
 *  Used in two places:
 *    1. `onchainVerify` to compose the `identityKey` after a fresh
 *       login (the credentialId is the JWT `sub` — drepId/poolId/
 *       ccCred/stakeAddr — but we need to know which namespace to
 *       prefix it with).
 *    2. The link flow's verifier, for the same reason. */
export function credentialTypeForRole(role: OnChainRole): IdentityCredentialType {
  switch (role) {
    case 'drep':
      return 'drep';
    case 'spo':
      return 'pool';
    case 'cc':
      return 'cc';
    case 'proposer':
      return 'stake';
    default: {
      // Exhaustiveness — never reached at runtime if the role union is
      // honoured. Throw rather than silently routing into an empty
      // string PK.
      const _exhaustive: never = role;
      throw new Error(`credentialTypeForRole: unsupported role ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Person row (onchain_users) helpers
// ---------------------------------------------------------------------------

/** Read a person row by id. Returns undefined when absent — callers
 *  treat that as "no person yet" (the auto-provision path mints one
 *  on a fresh login). */
export async function getPerson(personId: string): Promise<OnchainUserItem | undefined> {
  return await getItem<OnchainUserItem>(tableNames.onchainUsers, { personId });
}

/** Mint a fresh person row with the supplied id (or generate a new
 *  ULID when no id is passed). The row is empty apart from the
 *  bookkeeping; the link flow + `me` aggregation work with the empty
 *  shell until the user edits their profile. */
export async function createPerson(opts: { personId?: string } = {}): Promise<OnchainUserItem> {
  const personId = opts.personId ?? ulid();
  const now = new Date().toISOString();
  const row: OnchainUserItem = {
    personId,
    createdAt: now,
    updatedAt: now,
  };
  await putItem(tableNames.onchainUsers, row);
  return row;
}

/** Update the editable fields on a person row. Only the supplied keys
 *  are written; the rest is preserved. */
export async function updatePersonProfile(
  personId: string,
  patch: {
    displayName?: string | null;
    bio?: string | null;
    socialLinks?: SocialLinks | null;
  },
): Promise<OnchainUserItem> {
  const existing = await getPerson(personId);
  if (!existing) {
    throw new Error(`updatePersonProfile: person ${personId} not found`);
  }
  const now = new Date().toISOString();
  const updated: OnchainUserItem = {
    ...existing,
    // A `null` payload means "clear the field"; an absent key means
    // "leave the previous value alone." A trimmed empty string is
    // treated the same as null (don't persist garbage whitespace).
    ...(patch.displayName !== undefined
      ? patch.displayName === null || patch.displayName.trim() === ''
        ? { displayName: undefined }
        : { displayName: patch.displayName.trim() }
      : {}),
    ...(patch.bio !== undefined
      ? patch.bio === null || patch.bio === ''
        ? { bio: undefined }
        : { bio: patch.bio }
      : {}),
    ...(patch.socialLinks !== undefined
      ? patch.socialLinks === null
        ? { socialLinks: undefined }
        : { socialLinks: patch.socialLinks }
      : {}),
    updatedAt: now,
  };
  // Strip explicit-undefined keys so the persisted item doesn't carry
  // null attributes (DDB's `removeUndefinedValues` already handles
  // this on write, but the in-memory return is cleaner without them).
  for (const k of ['displayName', 'bio', 'socialLinks'] as const) {
    if (updated[k] === undefined) {
      delete updated[k];
    }
  }
  await putItem(tableNames.onchainUsers, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Identity-link helpers (identity_links)
// ---------------------------------------------------------------------------

/** Read a link row by identity key. Returns undefined when absent. */
export async function getIdentityLink(
  identityKey: string,
): Promise<IdentityLinkItem | undefined> {
  return await getItem<IdentityLinkItem>(tableNames.identityLinks, { identityKey });
}

/** List every credential mapped to a person. Single-partition Query
 *  against the `personId-verifiedAt-index` GSI, sorted by
 *  `verifiedAt` ascending (oldest first — the credential the person
 *  first signed up with sorts first). Pages internally so callers
 *  see the full set. */
export async function listPersonCredentials(personId: string): Promise<IdentityLinkItem[]> {
  const out: IdentityLinkItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await queryItems<IdentityLinkItem>(tableNames.identityLinks, {
      indexName: 'personId-verifiedAt-index',
      keyConditionExpression: '#personId = :personId',
      expressionAttributeNames: { '#personId': 'personId' },
      expressionAttributeValues: { ':personId': personId },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    out.push(...page.items);
    cursor = page.lastEvaluatedKey;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation — the load-bearing public surface
// ---------------------------------------------------------------------------

/**
 * Login-path reconciliation: given a freshly-verified on-chain
 * credential, return the canonical `personId`. Auto-provisions a new
 * person + link on the first login for an unmapped credential.
 *
 * Race-safety: between the GetItem and the PutItem(person) +
 * PutItemIfAbsent(link), a concurrent login on the SAME credential
 * could mint a second person. The conditional Put on the link row
 * detects that race; on conflict we re-read the existing link and use
 * its `personId` (the loser leaves an orphan person row, which is
 * harmless — those are scrubbed by a future GC and the link is the
 * source of truth). The narrow window means the orphan rate is
 * vanishingly small in practice.
 */
export async function resolveOrProvisionPerson(
  credentialType: IdentityCredentialType,
  credentialId: string,
  origin: IdentityLinkOrigin,
): Promise<{ personId: string; created: boolean }> {
  const identityKey = identityKeyFor(credentialType, credentialId);
  const existing = await getIdentityLink(identityKey);
  if (existing) {
    return { personId: existing.personId, created: false };
  }

  const person = await createPerson();
  const now = new Date().toISOString();
  const link: IdentityLinkItem = {
    identityKey,
    personId: person.personId,
    credentialType,
    verifiedAt: now,
    verifiedVia: origin,
  };
  const outcome = await putItemIfAbsent(tableNames.identityLinks, link, {
    partitionKey: 'identityKey',
  });
  if (outcome.outcome === 'errored') {
    throw outcome.error instanceof Error
      ? outcome.error
      : new Error('resolveOrProvisionPerson: identity_links write failed');
  }
  if (outcome.outcome === 'skipped') {
    // Concurrent provision raced us — the link row is now present.
    // Re-read to pick up the winner's personId. The person row we
    // just minted is an orphan; harmless and removable by GC later.
    const winner = await getIdentityLink(identityKey);
    if (!winner) {
      throw new Error(
        'resolveOrProvisionPerson: skipped insert but no winner row present',
      );
    }
    return { personId: winner.personId, created: false };
  }
  return { personId: person.personId, created: true };
}

/**
 * Link-flow reconciliation: map a freshly-verified credential to the
 * caller's EXISTING personId.
 *
 * Three branches (the safety gate is the second one):
 *
 *   1. The credential is already linked to the SAME personId →
 *      idempotent success.
 *   2. The credential is already linked to a DIFFERENT personId →
 *      REJECT with `AlreadyLinkedError`. Account-merge is out of
 *      scope; the safety guarantee is "we never silently merge
 *      two persons."
 *   3. The credential is unlinked → write the link row with
 *      `verifiedVia='link'` and return success.
 *
 * `linkedFromRole` is informational — it records which on-chain role
 * the caller's current session was authenticated under at the time of
 * the link. It does NOT participate in any security decision.
 */
export class AlreadyLinkedError extends Error {
  public readonly existingPersonId: string;
  constructor(existingPersonId: string) {
    super('credential already linked to another account');
    this.name = 'AlreadyLinkedError';
    this.existingPersonId = existingPersonId;
  }
}

export async function linkCredentialToPerson(args: {
  credentialType: IdentityCredentialType;
  credentialId: string;
  personId: string;
  linkedFromRole?: OnChainRole;
}): Promise<{ alreadyLinked: boolean }> {
  const { credentialType, credentialId, personId, linkedFromRole } = args;
  const identityKey = identityKeyFor(credentialType, credentialId);

  const existing = await getIdentityLink(identityKey);
  if (existing) {
    if (existing.personId === personId) {
      return { alreadyLinked: true };
    }
    throw new AlreadyLinkedError(existing.personId);
  }

  const now = new Date().toISOString();
  const link: IdentityLinkItem = {
    identityKey,
    personId,
    credentialType,
    verifiedAt: now,
    verifiedVia: 'link',
    ...(linkedFromRole ? { linkedFromRole } : {}),
  };
  const outcome = await putItemIfAbsent(tableNames.identityLinks, link, {
    partitionKey: 'identityKey',
  });
  if (outcome.outcome === 'errored') {
    throw outcome.error instanceof Error
      ? outcome.error
      : new Error('linkCredentialToPerson: identity_links write failed');
  }
  if (outcome.outcome === 'skipped') {
    // A concurrent writer claimed the key. Re-read; if it's our
    // personId we're done (idempotent), otherwise reject.
    const winner = await getIdentityLink(identityKey);
    if (!winner) {
      throw new Error(
        'linkCredentialToPerson: skipped insert but no winner row present',
      );
    }
    if (winner.personId === personId) {
      return { alreadyLinked: true };
    }
    throw new AlreadyLinkedError(winner.personId);
  }
  return { alreadyLinked: false };
}

/**
 * Derive the credential-id portion (after the namespace prefix) from
 * a stored `identityKey`. Used by the `/auth/onchain/me` aggregation
 * to surface the bare credential id alongside its type without
 * re-deriving it. Returns null when the shape doesn't match the
 * expected `<type>:<id>` form (defensive — should not happen for rows
 * written by this module).
 */
export function parseIdentityKey(
  identityKey: string,
): { credentialType: IdentityCredentialType; credentialId: string } | null {
  const idx = identityKey.indexOf(':');
  if (idx <= 0) return null;
  const type = identityKey.slice(0, idx);
  const id = identityKey.slice(idx + 1);
  if (id.length === 0) return null;
  if (type === 'drep' || type === 'pool' || type === 'cc' || type === 'stake') {
    return { credentialType: type, credentialId: id };
  }
  return null;
}
