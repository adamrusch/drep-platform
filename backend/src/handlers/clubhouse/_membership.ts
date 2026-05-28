/**
 * Shared Clubhouse membership gate.
 *
 * The Clubhouse surface (top-level posts AND replies) is private to:
 *   (a) the DRep's own committee — lead DRep, committee_member, or
 *       trusted_delegator (resolved from the `drep_committees` row), AND
 *   (b) wallets currently delegating to that DRep on-chain (resolved
 *       live via `lookupCurrentDrep`, which asks Koios then Blockfrost).
 *
 * Both `createPost` and `createComment` enforce the same gate — top-
 * level posts and replies have identical membership semantics. This
 * helper concentrates the policy so the two handlers can't drift.
 *
 * **Soft-fail on upstream outage:** if BOTH Koios AND Blockfrost are
 * unreachable for the delegation lookup, the helper returns
 * `delegationUnknown=true` and the calling handler falls through to
 * "allow" rather than 503 the surface. The role-holder branch (a DDB
 * Get on `drep_committees`) is unaffected by upstream weather, so
 * role-holders are never locked out. See `lib/recognition.ts` for the
 * same pattern.
 *
 * **Previously (≤ 2026-05-27):** the platform's spec carried "top-level
 * posts are role-only; replies are open to delegators." The 2026-05-28
 * change unifies both surfaces under the delegator-OR-role gate after
 * the user reported they couldn't post in their own delegated-DRep's
 * clubhouse — the platform-level intent for Clubhouse is now "the DRep
 * and their delegators talk together," not "the DRep broadcasts to
 * delegators." See the commit message for the rationale.
 */
import { getItem, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem } from '../../lib/types';
import { lookupCurrentDrep } from '../../lib/recognition';

export interface MembershipDecision {
  /** True when the caller is a member of this clubhouse's committee
   *  (lead DRep, committee_member, or trusted_delegator) for THIS drepId.
   *  Strongest signal — role-holders can ALWAYS write in clubhouses
   *  they manage, irrespective of their wallet's current delegation. */
  isRoleHolder: boolean;
  /** True when the caller's wallet stake currently delegates to THIS
   *  DRep (Koios/Blockfrost confirmed). */
  isCurrentDelegator: boolean;
  /** True when neither Koios nor Blockfrost could be reached to resolve
   *  the current delegation. Callers fall back to "allow" in this case
   *  so a transient upstream outage doesn't 503 the surface. The
   *  role-holder branch above still applies. */
  delegationUnknown: boolean;
  /** The committee row for this DRep when one exists. Returned so the
   *  caller can derive role-specific info (e.g. `createPost` uses it
   *  to set `isDRepPost`) without a second DDB Get. `undefined` when
   *  no committee exists, the Get failed, OR the caller is purely a
   *  delegator with no committee role — caller should not infer
   *  membership from this field; use `isRoleHolder` for that. */
  committee?: DRepCommitteeItem;
}

/**
 * Resolve membership signals for a caller against a given clubhouse.
 * Reads the committee row (small single-Get) and runs the live
 * delegation lookup in parallel.
 */
export async function resolveClubhouseMembership(
  walletAddress: string,
  drepId: string,
): Promise<MembershipDecision> {
  const [committee, delegationResult] = await Promise.all([
    getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
      drepId,
      SK: 'COMMITTEE',
    }).catch((err) => {
      // Defensive — a committee Get failure shouldn't 5xx the surface.
      // Log and treat the caller as a non-role-holder; the delegator
      // branch still has a chance to allow them through.
      console.warn(`resolveClubhouseMembership: committee Get failed for ${drepId}:`, err);
      return undefined;
    }),
    lookupCurrentDrep(walletAddress).catch((err) => {
      console.warn(
        `resolveClubhouseMembership: lookupCurrentDrep threw for ${walletAddress}:`,
        err,
      );
      return { drepId: null, source: null } as const;
    }),
  ]);

  let isRoleHolder = false;
  if (committee) {
    if (committee.leadWallet === walletAddress) {
      isRoleHolder = true;
    } else if (Array.isArray(committee.members)) {
      isRoleHolder = committee.members.some(
        (m) => m.walletAddress === walletAddress,
      );
    }
  }

  return {
    isRoleHolder,
    isCurrentDelegator:
      delegationResult.source !== null && delegationResult.drepId === drepId,
    delegationUnknown: delegationResult.source === null,
    ...(committee ? { committee } : {}),
  };
}
