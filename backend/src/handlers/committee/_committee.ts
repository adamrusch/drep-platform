import { getItem, batchGetItems, queryItems, updateItem, tableNames } from '../../lib/dynamodb';
import type { AuthContext } from '../../middleware/role-guard';
import { AuthorizationError } from '../../middleware/role-guard';
import {
  validateMutationNonce,
  verifyWalletSignature,
} from '../../lib/auth';
import { resolveCommitteeVote } from '../../lib/committeeVoteResolver';
import type {
  DRepCommitteeItem,
  CommitteeMemberItem,
  VotingConfigItem,
  CommitteeVoteProposalItem,
  CommitteeVoteCastItem,
  CommitteeCastVote,
  CommitteeProposalStatus,
  CommitteeTallySnapshot,
  CommitteeRationaleDraftItem,
  CommitteeRationaleLockItem,
  CommitteeRationaleFinalItem,
  RationaleMode,
  GovernanceActionItem,
  UserItem,
} from '../../lib/types';

/** A collaborative edit lock auto-expires after 20 min of no heartbeat. */
export const RATIONALE_LOCK_TTL_SEC = 20 * 60;

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

/** Minimum committee size (Chair + ≥2 registered members). */
export const MIN_COMMITTEE_MEMBERS = 3;

/** Simple-majority default for a legacy committee with no explicit X set. */
export function defaultApprovalThreshold(memberCount: number): number {
  return Math.floor(memberCount / 2) + 1;
}

/** The LIVE "X of N" rule for a committee: X = approvalThreshold (or a
 *  simple-majority default), N = current member count. */
export function currentApprovalRule(
  committee: DRepCommitteeItem,
): { approvalThreshold: number; memberCount: number } {
  const memberCount = committee.members?.length ?? 0;
  const approvalThreshold = committee.approvalThreshold ?? defaultApprovalThreshold(memberCount);
  return { approvalThreshold, memberCount };
}

/** The "X of N" rule SNAPSHOTTED on a proposal at open time. New proposals
 *  carry approvalThreshold + memberCount; legacy ones fall back to the old
 *  quorum/threshold fields so they still resolve without crashing. */
export function approvalRuleFromProposal(
  p: Pick<CommitteeVoteProposalItem, 'approvalThreshold' | 'memberCount' | 'quorum' | 'thresholdPct'>,
): { approvalThreshold: number; memberCount: number } {
  const approvalThreshold = p.approvalThreshold ?? p.quorum ?? 1;
  const memberCount = p.memberCount ?? p.quorum ?? approvalThreshold;
  return { approvalThreshold, memberCount };
}

/** Build a persisted tally snapshot from casts + an "X of N" rule. */
export function buildTallySnapshot(
  casts: ReadonlyArray<{ voterWallet: string; vote: CommitteeCastVote }>,
  rule: { approvalThreshold: number; memberCount: number },
): CommitteeTallySnapshot {
  const r = resolveCommitteeVote({
    casts,
    approvalThreshold: rule.approvalThreshold,
    memberCount: rule.memberCount,
  });
  return {
    agreeCount: r.agreeCount,
    disagreeCount: r.disagreeCount,
    abstainCount: r.abstainCount,
    activePool: r.agreeCount + r.disagreeCount,
    agreePct: r.agreePct,
    approvalThreshold: r.approvalThreshold,
    memberCount: r.memberCount,
    approved: r.isApproved,
  };
}

/** Stamp each member with a live `active` flag (= has a users row / has logged
 *  in). One batched read; safe on an empty roster. */
export async function withMemberActivity(
  members: CommitteeMemberItem[] | undefined,
): Promise<CommitteeMemberItem[]> {
  if (!members || members.length === 0) return members ?? [];
  const keys = members.map((m) => ({ walletAddress: m.walletAddress, SK: 'PROFILE' }));
  const rows = await batchGetItems<UserItem>(tableNames.users, keys);
  const activeSet = new Set(rows.map((r) => r.walletAddress));
  return members.map((m) => ({ ...m, active: activeSet.has(m.walletAddress) }));
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

export async function loadRationaleDraft(
  voteScope: string,
): Promise<CommitteeRationaleDraftItem | undefined> {
  return getItem<CommitteeRationaleDraftItem>(tableNames.committeeVotes, {
    voteScope, itemKey: 'RATIONALE#DRAFT',
  });
}

export async function loadRationaleLock(
  voteScope: string,
): Promise<CommitteeRationaleLockItem | undefined> {
  return getItem<CommitteeRationaleLockItem>(tableNames.committeeVotes, {
    voteScope, itemKey: 'RATIONALE#LOCK',
  });
}

export async function loadRationaleFinal(
  voteScope: string,
): Promise<CommitteeRationaleFinalItem | undefined> {
  return getItem<CommitteeRationaleFinalItem>(tableNames.committeeVotes, {
    voteScope, itemKey: 'RATIONALE#FINAL',
  });
}

export function isLockHeldBy(
  lock: CommitteeRationaleLockItem | undefined,
  wallet: string,
  nowSec: number,
): boolean {
  return Boolean(lock && lock.editorWallet === wallet && lock.expiresAt > nowSec);
}

export function isLockActive(
  lock: CommitteeRationaleLockItem | undefined,
  nowSec: number,
): boolean {
  return Boolean(lock && lock.expiresAt > nowSec);
}

/**
 * Mode-aware rationale edit authorization. Returns null when allowed, or a
 * { code, message } describing the rejection.
 *   - 'lead'         → only the lead may edit.
 *   - 'assigned'     → the assigned editor (or the lead) may edit.
 *   - 'collaborative'→ any member may edit, but only while holding the lock.
 */
export function checkRationaleEditAuth(
  walletAddress: string,
  committee: DRepCommitteeItem,
  mode: RationaleMode,
  assignedEditor: string | undefined,
  lock: CommitteeRationaleLockItem | undefined,
  nowSec: number,
): { code: 403 | 409; message: string } | null {
  const isLead = committee.leadWallet === walletAddress;
  const isMember = isLead || (committee.members?.some((m) => m.walletAddress === walletAddress) ?? false);
  if (!isMember) return { code: 403, message: 'You are not a member of this committee' };

  if (mode === 'lead') {
    return isLead ? null : { code: 403, message: 'Only the lead DRep may edit this rationale' };
  }
  if (mode === 'assigned') {
    return isLead || walletAddress === assignedEditor
      ? null
      : { code: 403, message: 'Only the assigned editor or the lead DRep may edit this rationale' };
  }
  // collaborative
  if (!isLockHeldBy(lock, walletAddress, nowSec)) {
    const holder = isLockActive(lock, nowSec) ? lock?.editorWallet : undefined;
    return {
      code: 409,
      message: holder
        ? `${holder} is currently editing this rationale. Try again when they're done.`
        : 'Open the rationale for editing first (acquire the edit lock).',
    };
  }
  return null;
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

/**
 * Race-safe terminal transition of an OPEN proposal. Conditional on
 * `status = 'open'`, so a manual close racing the epoch sweep (or two members
 * clicking at once) — only the first wins; the loser gets 'not_open'. Always
 * REMOVEs statusPartition so the open-proposal GSI shrinks.
 */
export async function transitionOpenProposal(
  voteScope: string,
  patch: {
    status: CommitteeProposalStatus;
    closedReason: NonNullable<CommitteeVoteProposalItem['closedReason']>;
    closedByWallet: string;
    finalTally?: CommitteeTallySnapshot;
  },
): Promise<'ok' | 'not_open'> {
  const sets = [
    '#status = :status',
    'closedAt = :now',
    'closedByWallet = :w',
    'closedReason = :reason',
  ];
  const values: Record<string, unknown> = {
    ':status': patch.status,
    ':now': new Date().toISOString(),
    ':w': patch.closedByWallet,
    ':reason': patch.closedReason,
    ':open': 'open',
  };
  if (patch.finalTally) {
    sets.push('finalTally = :tally');
    values[':tally'] = patch.finalTally;
  }
  const updateExpression = `SET ${sets.join(', ')} REMOVE statusPartition`;
  try {
    await updateItem(
      tableNames.committeeVotes,
      { voteScope, itemKey: 'PROPOSAL' },
      updateExpression,
      { '#status': 'status' },
      values,
      '#status = :open',
    );
    return 'ok';
  } catch (err) {
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return 'not_open';
    }
    throw err;
  }
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
