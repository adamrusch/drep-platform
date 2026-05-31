import { getItem, tableNames } from './dynamodb';
import type { UserItem, CommitteeMembershipItem } from './types';

export interface ResolvedIdentity {
  /** Name to display: user-set profile name → DRep name → undefined (FE then
   *  shows a truncated stake address). */
  displayName?: string;
  /** True if this wallet is a registered DRep (leads a committee bound to a
   *  drep id). */
  isDRep: boolean;
  /** The drep id, when isDRep. */
  drepId?: string;
  /** The DRep's on-chain name, when isDRep. */
  drepName?: string;
}

/**
 * Resolve a wallet's display identity with a single, consistent precedence used
 * everywhere a name is shown (clubhouse posts/comments, etc.):
 *
 *   1. the user's self-chosen profile display name, if set;
 *   2. else, if the wallet leads a committee (i.e. is a DRep), the DRep's
 *      on-chain (CIP-119) name;
 *   3. else undefined — the FE falls back to a truncated stake address.
 *
 * "Is a DRep" is determined by the committee_membership link (role 'lead'),
 * since a dedicated DRep key isn't derivable from the wallet address.
 */
export async function resolveIdentity(walletAddress: string): Promise<ResolvedIdentity> {
  const [user, membership] = await Promise.all([
    getItem<UserItem>(tableNames.users, { walletAddress, SK: 'PROFILE' }),
    getItem<CommitteeMembershipItem>(tableNames.committeeMembership, { walletAddress }),
  ]);

  const isDRep = membership?.role === 'lead' && Boolean(membership?.drepId);
  let drepName: string | undefined;
  if (isDRep && membership?.drepId) {
    const dir = await getItem<{ givenName?: string }>(tableNames.drepDirectory, {
      drepId: membership.drepId,
      SK: 'PROFILE',
    });
    drepName = dir?.givenName;
  }

  const displayName = user?.displayName || drepName || undefined;

  return {
    displayName,
    isDRep,
    ...(isDRep ? { drepId: membership?.drepId, drepName } : {}),
  };
}
