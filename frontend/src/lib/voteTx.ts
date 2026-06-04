/**
 * Helpers for the CIP-1694 DRep vote transaction build/sign/broadcast.
 *
 * Lives separate from `SubmitVotePanel.tsx` so:
 *   1. The actionId parser, the position→VoteKind map, and the
 *      pre-flight-balance helper can be unit-tested without rendering React.
 *   2. The dynamic `import('@meshsdk/transaction')` is colocated with the
 *      code that uses it — the panel only renders for a lead on a passed
 *      proposal, and we want the ~5 MB Mesh chunk to stay lazy. Pulling
 *      the import into a hook above the component would defeat that.
 *
 * Mesh API surface used (versions pinned by `frontend/node_modules/@meshsdk/*`
 * at the time of this commit: `@meshsdk/core` 1.8.14, `@meshsdk/transaction`
 * 1.8.14, `@meshsdk/common` 1.8.14):
 *
 *   - `MeshTxBuilder` — `vote(voter, govActionId, votingProcedure)`,
 *     `changeAddress`, `selectUtxosFrom`, `complete`.
 *   - `Voter = { type: 'DRep', drepId }`.
 *   - `RefTxIn = { txHash, txIndex }` — what `vote()` accepts as govActionId.
 *   - `VotingProcedure = { voteKind: 'Yes'|'No'|'Abstain', anchor? }`.
 *   - `Anchor = { anchorUrl, anchorDataHash }`.
 *
 * The wallet side (BrowserWallet) is also Mesh's, but we keep it pluggable
 * via interfaces here so the helper doesn't import `@meshsdk/wallet` at
 * module-eval time (it's already pulled in via `@meshsdk/core` exports
 * from the panel's dynamic import).
 */

import type { CommitteePosition } from '@/types/committee';

/** Minimal wallet API used by the helper. Implemented by Mesh's
 *  `BrowserWallet` instance (after `.enable(walletName, [95])`). */
export interface VoteWallet {
  getChangeAddress: () => Promise<string>;
  getUtxos: () => Promise<unknown[]>;
  signTx: (unsignedTx: string, partialSign?: boolean) => Promise<string>;
  submitTx: (tx: string) => Promise<string>;
}

/** Position string the backend stores → CIP-1694 VoteKind string Mesh expects. */
export function positionToVoteKind(p: CommitteePosition): 'Yes' | 'No' | 'Abstain' {
  if (p === 'Yes') return 'Yes';
  if (p === 'No') return 'No';
  return 'Abstain';
}

/**
 * Parse the platform's `"<txHash>#<index>"` actionId into Mesh's
 * `RefTxIn = { txHash, txIndex }`. The format is confirmed by the
 * `governance_actions` PK shape (e.g. seed data `'abcd1234#0'`) and is
 * also what `actionId` is encoded as throughout the codebase.
 *
 * Throws if the input doesn't match. The error message names the
 * malformed value so callers can render it as a "vote not cast"
 * inline reason without losing diagnostic info.
 */
export function parseActionIdToGovActionId(
  actionId: string,
): { txHash: string; txIndex: number } {
  const hash = '#';
  const idx = actionId.indexOf(hash);
  if (idx < 0) {
    throw new Error(`Malformed actionId "${actionId}" — expected "<txHash>#<index>".`);
  }
  const txHash = actionId.slice(0, idx);
  const idxRaw = actionId.slice(idx + 1);
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error(`Malformed actionId "${actionId}" — txHash must be 64 hex chars.`);
  }
  if (!/^\d+$/.test(idxRaw)) {
    throw new Error(`Malformed actionId "${actionId}" — index must be a non-negative integer.`);
  }
  const txIndex = Number(idxRaw);
  if (!Number.isFinite(txIndex) || txIndex < 0) {
    throw new Error(`Malformed actionId "${actionId}" — index out of range.`);
  }
  return { txHash, txIndex };
}

/**
 * The Mesh `UTxO` shape we care about for the pre-flight balance check.
 * `amount` is an array of `{ unit, quantity }` — `unit === 'lovelace'` is
 * the ADA value of that UTxO; everything else is a native asset.
 */
interface MeshUtxoShape {
  output?: {
    amount?: ReadonlyArray<{ unit?: string; quantity?: string }>;
  };
}

/** Sum the ADA in an array of Mesh UTxOs. Tolerates malformed entries
 *  (treats missing `lovelace` as 0) — callers only use the sum for a
 *  user-facing "you might be short on ADA" warning, not for the tx fee. */
export function totalLovelace(utxos: ReadonlyArray<unknown>): bigint {
  let total = 0n;
  for (const u of utxos as ReadonlyArray<MeshUtxoShape>) {
    const amount = u?.output?.amount ?? [];
    for (const a of amount) {
      if (a?.unit === 'lovelace' && a.quantity) {
        try { total += BigInt(a.quantity); } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/** Rough "do you have enough ADA for a DRep vote tx fee?" threshold.
 *  Mainnet vote txs typically settle for ~0.18–0.25 ADA in fees; we set
 *  the warning bar at 0.5 ADA (500_000 lovelace) so the user has clear
 *  headroom AND the lovelace balance comfortably covers the change
 *  output minimum. The threshold gates the WARNING — not the click —
 *  because Mesh's coin selection may still find a workable set and the
 *  wallet decides for itself whether to sign. */
export const MIN_LOVELACE_FOR_VOTE = 500_000n;

/**
 * Inputs the helper needs to build a vote tx. Owned by the caller (the
 * panel reads them from the readiness payload + the wallet + the
 * committee row).
 */
export interface BuildVoteTxInputs {
  drepId: string;
  /** Platform actionId in `<txHash>#<index>` form. */
  actionId: string;
  /** The proposal's tallied position — drives VoteKind. */
  position: CommitteePosition;
  /** IPFS URI of the rationale (if a final rationale exists). */
  anchorUrl?: string | null;
  /** Hex blake2b-256 hash of the canonical rationale bytes. */
  anchorHash?: string | null;
  /** The wallet we sign + broadcast with — must be CIP-95-enabled. */
  wallet: VoteWallet;
}

/**
 * The Mesh imports the helper needs at runtime — injected by the caller
 * after a dynamic `import()` so the helper itself stays import-safe in
 * unit tests (which never touch the WASM bundle).
 */
export interface MeshDeps {
  MeshTxBuilder: new (opts?: Record<string, unknown>) => {
    vote: (
      voter: { type: 'DRep'; drepId: string },
      govActionId: { txHash: string; txIndex: number },
      votingProcedure: {
        voteKind: 'Yes' | 'No' | 'Abstain';
        anchor?: { anchorUrl: string; anchorDataHash: string };
      },
    ) => {
      changeAddress: (addr: string) => {
        selectUtxosFrom: (utxos: unknown[]) => {
          complete: () => Promise<string>;
        };
      };
    };
  };
}

/**
 * Build the unsigned CIP-1694 vote tx. Pure assembly — the helper does
 * NOT sign, submit, or touch DOM; the panel orchestrates the wallet
 * dance.
 */
export async function buildUnsignedVoteTx(
  inputs: BuildVoteTxInputs,
  deps: MeshDeps,
): Promise<string> {
  const govActionId = parseActionIdToGovActionId(inputs.actionId);
  const voteKind = positionToVoteKind(inputs.position);
  const voter = { type: 'DRep' as const, drepId: inputs.drepId };
  // The anchor is optional in CIP-1694: when a rationale was finalized
  // we attach it; without one (override case) the vote carries no
  // anchor and the `rationaleOverridden` flag persists in the receipt
  // row instead.
  const anchor =
    inputs.anchorUrl && inputs.anchorHash
      ? { anchorUrl: inputs.anchorUrl, anchorDataHash: inputs.anchorHash }
      : undefined;
  const votingProcedure = anchor ? { voteKind, anchor } : { voteKind };
  const changeAddress = await inputs.wallet.getChangeAddress();
  const utxos = await inputs.wallet.getUtxos();
  const builder = new deps.MeshTxBuilder({});
  const unsigned = await builder
    .vote(voter, govActionId, votingProcedure)
    .changeAddress(changeAddress)
    .selectUtxosFrom(utxos)
    .complete();
  return unsigned;
}
