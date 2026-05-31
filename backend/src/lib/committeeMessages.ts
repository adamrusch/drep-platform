// ============================================================
// Committee mutation signing messages — CANONICAL SOURCE.
//
// Every committee mutation (propose, cast, close, finalize, member changes,
// config, register, on-chain submit, admin actions) is authorised by a fresh
// CIP-30 signature over one of these plaintext messages. The message encodes
// the action's salient fields so the signature is non-repudiable evidence of
// *what* was authorised — not just "some mutation".
//
// Two invariants:
//   1. Issuer (frontend, when signing) and verifier (backend handler) MUST
//      produce byte-identical strings. This file is DUPLICATED verbatim into
//      backend/src/lib/committeeMessages.ts and frontend/src/lib/committeeMessages.ts
//      (the repo avoids cross-workspace imports — see backend/src/lib/types.ts).
//      A golden test on each side pins the exact output; keep all three copies
//      identical and bump COMMITTEE_MSG_FORMAT on any change.
//   2. The STAGE is embedded in every message, so a signature produced on
//      test.drep.tools physically cannot verify on prod (and vice versa).
// ============================================================

export const COMMITTEE_MSG_FORMAT = 'v1';

/**
 * Generic builder. Layout:
 *
 *   drep-platform committee <action> [<fmt>] (stage=<stage>):
 *
 *   Wallet: <wallet>
 *   <Field>: <value>
 *   ...
 *   Nonce: <nonce>
 */
export function buildCommitteeMessage(
  stage: string,
  action: string,
  fields: ReadonlyArray<readonly [string, string]>,
  nonce: string,
  wallet: string,
): string {
  const lines = [
    `Wallet: ${wallet}`,
    ...fields.map(([k, v]) => `${k}: ${v}`),
    `Nonce: ${nonce}`,
  ];
  return `drep-platform committee ${action} [${COMMITTEE_MSG_FORMAT}] (stage=${stage}):\n\n${lines.join('\n')}`;
}

export type CloseOutcome = 'pass' | 'fail' | 'withdraw';
export type MemberAction = 'add' | 'remove';

export const committeeMessages = {
  register: (stage: string, committeeName: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(stage, 'register', [['Committee-Name', committeeName]], nonce, wallet),

  proposal: (stage: string, drepId: string, actionId: string, position: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'proposal',
      [['Committee', drepId], ['Action', actionId], ['Position', position]],
      nonce,
      wallet,
    ),

  cast: (stage: string, drepId: string, actionId: string, vote: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'vote',
      [['Committee', drepId], ['Action', actionId], ['Vote', vote]],
      nonce,
      wallet,
    ),

  close: (stage: string, drepId: string, actionId: string, outcome: CloseOutcome, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'close',
      [['Committee', drepId], ['Action', actionId], ['Outcome', outcome]],
      nonce,
      wallet,
    ),

  rationaleFinalize: (stage: string, drepId: string, actionId: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'rationale-finalize',
      [['Committee', drepId], ['Action', actionId]],
      nonce,
      wallet,
    ),

  member: (stage: string, drepId: string, action: MemberAction, targetWallet: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'member',
      [['Committee', drepId], ['MemberAction', action], ['Target', targetWallet]],
      nonce,
      wallet,
    ),

  votingConfig: (stage: string, drepId: string, thresholdPct: number, rationaleMode: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'voting-config',
      [['Committee', drepId], ['ThresholdPct', String(thresholdPct)], ['RationaleMode', rationaleMode]],
      nonce,
      wallet,
    ),

  submit: (stage: string, drepId: string, actionId: string, position: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'submit',
      [['Committee', drepId], ['Action', actionId], ['Position', position]],
      nonce,
      wallet,
    ),

  submitReceipt: (stage: string, drepId: string, actionId: string, txHash: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(
      stage,
      'submit-receipt',
      [['Committee', drepId], ['Action', actionId], ['TxHash', txHash]],
      nonce,
      wallet,
    ),

  ipfsKey: (stage: string, drepId: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(stage, 'ipfs-key', [['Committee', drepId]], nonce, wallet),

  admin: (stage: string, action: string, target: string, nonce: string, wallet: string) =>
    buildCommitteeMessage(stage, 'admin', [['AdminAction', action], ['Target', target]], nonce, wallet),
} as const;
