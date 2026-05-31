import { getItem, tableNames } from './dynamodb';
import type { UserItem } from './types';

export interface ResolvedIdentity {
  /** Name to display: user-set profile name → DRep name → undefined (FE then
   *  shows a truncated stake address). */
  displayName?: string;
  /** True if this wallet is a registered DRep (has a linked, on-chain-registered
   *  drep id). */
  isDRep: boolean;
  /** The drep id, when isDRep. */
  drepId?: string;
  /** The DRep's on-chain name, when isDRep. */
  drepName?: string;
}

/**
 * Resolve a wallet's display identity with a single, consistent precedence used
 * everywhere a name is shown (clubhouse posts/comments, profile page, …):
 *
 *   1. the user's self-chosen profile display name, if set;
 *   2. else, if the wallet is a registered DRep, the DRep's on-chain
 *      (CIP-119) name;
 *   3. else undefined — the FE falls back to a truncated stake address.
 *
 * "Is a DRep" keys off the user's linked `drepId` (set by /drep/link OR by
 * registering a committee) AND that drep id being present in the on-chain
 * directory. This deliberately does NOT require a committee — a DRep who just
 * wants a profile is recognized too.
 */
export async function resolveIdentity(walletAddress: string): Promise<ResolvedIdentity> {
  const user = await getItem<UserItem>(tableNames.users, { walletAddress, SK: 'PROFILE' });
  const drepId = user?.drepId as string | undefined;

  let isDRep = false;
  let drepName: string | undefined;
  if (drepId) {
    const dir = await getItem<{ givenName?: string }>(tableNames.drepDirectory, {
      drepId,
      SK: 'PROFILE',
    });
    if (dir) {
      isDRep = true;
      drepName = dir.givenName;
    }
  }

  const displayName = user?.displayName || drepName || undefined;

  return {
    displayName,
    isDRep,
    ...(isDRep ? { drepId, drepName } : {}),
  };
}
