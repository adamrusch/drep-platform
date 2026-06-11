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
import {
  CIP20_LABEL,
  buildDefaultDrepToolsAttribution,
  type Cip20Envelope,
} from './cip20';

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
  /**
   * CIP-20 attribution metadata (label 674) to attach to the tx.
   *   - `undefined` (default) → attach the platform's drep.tools attribution.
   *   - `null` → do not attach any CIP-20 metadata.
   *   - `Cip20Envelope` → attach the provided envelope as-is.
   *
   * Most callers omit this to get the default "Voted via drep.tools"
   * stamp. Tests use `null` to assert the no-metadata branch.
   */
  attributionMetadata?: Cip20Envelope | null;
}

/**
 * The Mesh imports the helper needs at runtime — injected by the caller
 * after a dynamic `import()` so the helper itself stays import-safe in
 * unit tests (which never touch the WASM bundle).
 *
 * The chain is modelled as nested return types rather than `this`-fluent
 * — real Mesh returns `this` from every chainable call, but a `this`-typed
 * mock complicates the existing vitest setup. The nested shape captures
 * the exact methods we use in order and lets tests assert each call's
 * args without redefining the whole builder.
 *
 * Sprint 6: the chain gains an optional `metadataValue(label, value)`
 * step at the end so we can stamp CIP-20 (label 674) attribution onto
 * every vote drep.tools assembles. Mesh accepts a plain JSON object at
 * `metadataValue` and emits it under the label in the tx metadata map.
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
          /** CIP-20 transaction-message metadata (label 674). The real
           *  Mesh API accepts `number | bigint | string` for the label
           *  and any JSON object for the metadata value. We always pass
           *  the literal number 674 and a `{ msg: string[] }` envelope
           *  — see `shared/cip20.ts` for the chunking rules. */
          metadataValue: (label: number, metadata: object) => {
            complete: () => Promise<string>;
          };
          /** Kept for back-compat with callers that don't attach
           *  metadata. Today the platform always attaches; this branch
           *  exists so a future caller (or test) can build the tx
           *  without CIP-20. */
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
 *
 * # CIP-20 attribution
 *
 * Every drep.tools-assembled vote carries a CIP-20 transaction-message
 * metadata entry under label 674. The default envelope is
 * `{ msg: ["Voted via drep.tools", "drep-tools"] }` — a human-readable
 * line plus a machine tag chain analysts can grep for. The label and
 * envelope shape come from `shared/cip20.ts` (mirrored byte-identically
 * into `lib/cip20.ts`).
 *
 * Callers can override or suppress attribution via the optional
 * `attributionMetadata` input:
 *   - omit / undefined → default drep.tools attribution attached.
 *   - `null`            → no metadata attached (escape hatch for tests
 *                         and any future caller that wants the bare tx).
 *   - `Cip20Envelope`   → use the provided envelope as-is.
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
  const afterCoinSelect = builder
    .vote(voter, govActionId, votingProcedure)
    .changeAddress(changeAddress)
    .selectUtxosFrom(utxos);
  // Sprint 6 — CIP-20 attribution. The platform always stamps; callers
  // pass `attributionMetadata: null` to suppress.
  const attribution =
    inputs.attributionMetadata === null
      ? null
      : (inputs.attributionMetadata ?? buildDefaultDrepToolsAttribution());
  const unsigned = attribution
    ? await afterCoinSelect.metadataValue(CIP20_LABEL, attribution).complete()
    : await afterCoinSelect.complete();
  return unsigned;
}
