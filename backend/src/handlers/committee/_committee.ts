import { getItem, queryItems, tableNames } from '../../lib/dynamodb';
import type { AuthContext } from '../../middleware/role-guard';
import { AuthorizationError } from '../../middleware/role-guard';
import {
  validateMutationNonce,
  verifyWalletSignature,
} from '../../lib/auth';
import type {
  DRepCommitteeItem,
  VotingConfigItem,
  CommitteeVoteProposalItem,
  CommitteeVoteCastItem,
  GovernanceActionItem,
} from '../../lib/types';

/** The deploy stage, embedded in committee signed messages (see
 *  lib/committeeMessages.ts). Defaults to 'dev' for local/test runs. */
export function getStage(): string {
  return process.env['STAGE'] ?? 'dev';
}

export const DEFAULT_THRESHOLD_PCT = 67;
export const DEFAULT_QUORUM = 3;

/** Load the COMMITTEE row for a drepId (or undefined). */
export async function loadCommittee(
  drepId: string,
): Promise<DRepCommitteeItem | undefined> {
  return getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
    drepId,
    SK: 'COMMITTEE',
  });
}

/** Load the lead-configured voting config, falling back to defaults. */
export async function loadVotingConfig(
  drepId: string,
): Promise<{ thresholdPct: number; quorum: number; item?: VotingConfigItem }> {
  const item = await getItem<VotingConfigItem>(tableNames.drepCommittees, {
    drepId,
    SK: 'VOTING_CONFIG',
  });
  return {
    thresholdPct: item?.thresholdPct ?? DEFAULT_THRESHOLD_PCT,
    quorum: item?.quorum ?? DEFAULT_QUORUM,
    item,
  };
}

/** Caller must be the lead OR a member of THIS committee (scoped — never
 *  trusts the global JWT roles array). */
export function assertCommitteeMember(
  authCtx: AuthContext,
  committee: DRepCommitteeItem,
): void {
  if (committee.leadWallet === authCtx.walletAddress) return;
  const isMember = committee.members?.some(
    (m) => m.walletAddress === authCtx.walletAddress,
  );
  if (!isMember) {
    throw new AuthorizationError('You are not a member of this committee', 403);
  }
}

/** Caller must be the lead of THIS committee. */
export function assertCommitteeLead(
  authCtx: AuthContext,
  committee: DRepCommitteeItem,
): void {
  if (committee.leadWallet !== authCtx.walletAddress) {
    throw new AuthorizationError('Only the lead DRep can perform this action', 403);
  }
}

/** Whether `wallet` is the proposer of a proposal or the committee lead. */
export function isProposerOrLead(
  authCtx: AuthContext,
  committee: DRepCommitteeItem,
  proposerWallet: string,
): boolean {
  return (
    authCtx.walletAddress === proposerWallet ||
    committee.leadWallet === authCtx.walletAddress
  );
}

/**
 * Consume the mutation nonce and verify the wallet signature against the
 * exact committee message that was supposed to be signed. Returns a reason
 * string on failure, or null on success.
 */
export async function verifyCommitteeResign(
  walletAddress: string,
  sig: { mutationNonce?: string; mutationSignature?: string; mutationKey?: string },
  message: string,
): Promise<string | null> {
  if (!sig.mutationNonce || !sig.mutationSignature || !sig.mutationKey) {
    return 'mutationNonce, mutationSignature, and mutationKey are required';
  }
  const nonceResult = await validateMutationNonce(sig.mutationNonce, walletAddress);
  if (!nonceResult.valid) {
    return nonceResult.reason ?? 'Invalid mutation nonce';
  }
  const sigResult = verifyWalletSignature(walletAddress, message, {
    signature: sig.mutationSignature,
    key: sig.mutationKey,
  });
  if (!sigResult.valid) {
    return sigResult.reason ?? 'Invalid mutation signature';
  }
  return null;
}

/** Persist a CommitteeSignature snapshot from a verified mutation body. */
export function signatureSnapshot(
  sig: { mutationNonce: string; mutationSignature: string; mutationKey: string },
  signedMessage: string,
) {
  return {
    mutationNonce: sig.mutationNonce,
    mutationSignature: sig.mutationSignature,
    mutationKey: sig.mutationKey,
    signedMessage,
  };
}

export function voteScopeOf(drepId: string, actionId: string): string {
  return `${drepId}#${actionId}`;
}

export async function loadGovernanceAction(
  actionId: string,
): Promise<GovernanceActionItem | undefined> {
  return getItem<GovernanceActionItem>(tableNames.governanceActions, {
    actionId,
    SK: 'ACTION',
  });
}

export async function loadProposal(
  voteScope: string,
): Promise<CommitteeVoteProposalItem | undefined> {
  return getItem<CommitteeVoteProposalItem>(tableNames.committeeVotes, {
    voteScope,
    itemKey: 'PROPOSAL',
  });
}

/** All rows in a vote partition (proposal + casts + rationale + submission). */
export async function loadVoteScopeItems(
  voteScope: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await queryItems<Record<string, unknown>>(tableNames.committeeVotes, {
    keyConditionExpression: 'voteScope = :vs',
    expressionAttributeValues: { ':vs': voteScope },
  });
  return res.items;
}

export function castRowsFrom(
  items: Array<Record<string, unknown>>,
): CommitteeVoteCastItem[] {
  return items.filter(
    (i) => typeof i['itemKey'] === 'string' && (i['itemKey'] as string).startsWith('CAST#'),
  ) as CommitteeVoteCastItem[];
}

/** Count this committee's currently-open proposals (for config-change warnings). */
export async function countOpenProposals(drepId: string): Promise<number> {
  const res = await queryItems<{ voteScope: string }>(tableNames.committeeVotes, {
    indexName: 'open-epochDeadline-index',
    keyConditionExpression: '#sp = :open',
    expressionAttributeNames: { '#sp': 'statusPartition' },
    expressionAttributeValues: { ':open': 'OPEN' },
    projectionExpression: 'voteScope',
  });
  const prefix = `${drepId}#`;
  return res.items.filter((i) => i.voteScope.startsWith(prefix)).length;
}
