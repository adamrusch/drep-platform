import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useSubmitVote, useSubmitReceipt, type SubmitReadiness } from '@/hooks/useCommitteeVotes';
import { useAuthStore } from '@/stores/authStore';
import { isTestStage } from '@/lib/stage';
import {
  buildUnsignedVoteTx,
  MIN_LOVELACE_FOR_VOTE,
  totalLovelace,
  type VoteWallet,
} from '@/lib/voteTx';

/**
 * On-chain submission for a passed proposal (lead only). The flow:
 *
 *   1. `prepare.mutate(...)` → readiness payload (backend gates broadcast
 *      via `canBroadcastGovernanceVote`; on `test`, only platform admins
 *      get `broadcastAllowed=true`).
 *
 *   2. If broadcast is allowed: render the wallet flow. Lazy-import the
 *      Mesh transaction + wallet modules (~5 MB WASM) at click time —
 *      this panel only ever renders for a lead on a passed proposal, so
 *      the chunk stays out of the main bundle for everyone else.
 *
 *   3. Enable the wallet with CIP-95, build the CIP-1694 vote tx with
 *      `MeshTxBuilder.vote(voter, govActionId, votingProcedure)`, sign
 *      with the wallet, submit via the wallet, and record the receipt
 *      with `confirmedRealMainnetVote: true`.
 *
 * # Test-environment safety
 *
 * `test.drep.tools` is wired to MAINNET. A successful broadcast here is
 * a real DRep vote that costs real ADA and shows up on Cardanoscan /
 * gov.tools — there is NO preview/preprod alternative. The panel
 * surfaces this with:
 *   - A red-bordered warning at the top of the panel.
 *   - A checkbox the user must tick before the "Sign & broadcast" button
 *     enables.
 *   - On the receipt POST, `confirmedRealMainnetVote: true` (backend
 *     rejects with 400 otherwise on `test`).
 *
 * Non-admin leads on `test` will get `broadcastAllowed=false` from the
 * readiness response — we render a calm "not yet available for your
 * account" message instead of the build flow.
 */
export function SubmitVotePanel({ drepId, actionId }: { drepId: string; actionId: string }): React.ReactElement {
  const { t } = useTranslation();
  const prepare = useSubmitVote(drepId, actionId);
  const receipt = useSubmitReceipt(drepId, actionId);
  const walletName = useAuthStore((s) => s.walletName);
  const isTest = isTestStage();
  const [override, setOverride] = useState(false);
  const [readiness, setReadiness] = useState<SubmitReadiness | null>(null);
  // On `test`, the user must explicitly tick the "I understand" box before
  // the broadcast button enables. The state lives in the panel rather than
  // the global store so it resets on every render of a fresh proposal —
  // we deliberately do NOT persist this across sessions / proposals.
  const [acknowledgedTest, setAcknowledgedTest] = useState(false);
  // Wallet-side state for the build → sign → submit dance.
  const [phase, setPhase] = useState<'idle' | 'building' | 'signing' | 'submitting' | 'recording'>('idle');
  const [error, setError] = useState<string | null>(null);
  // After a successful broadcast: keep the txHash around for the receipt
  // record step (and the success badge).
  const [broadcastTxHash, setBroadcastTxHash] = useState<string | null>(null);
  // After a successful balance pre-flight: surface a warning when the
  // wallet ADA looks too thin for a vote fee.
  const [balanceWarning, setBalanceWarning] = useState<string | null>(null);

  const onPrepare = (): void => {
    setError(null);
    prepare.mutate({ override }, { onSuccess: (r) => setReadiness(r as SubmitReadiness) });
  };

  // Only show the build/sign flow when the backend says broadcast is
  // allowed for THIS caller. On test for a non-admin lead this is false,
  // and we render the "not yet available" message instead.
  const canSign = useMemo(() => {
    if (!readiness?.broadcastAllowed) return false;
    if (isTest && !acknowledgedTest) return false;
    if (phase !== 'idle' || broadcastTxHash) return false;
    return Boolean(walletName);
  }, [readiness?.broadcastAllowed, isTest, acknowledgedTest, phase, broadcastTxHash, walletName]);

  const onSignAndBroadcast = async (): Promise<void> => {
    if (!readiness?.broadcastAllowed) return;
    if (!walletName) {
      setError(t('committeeSubmit.errors.noWalletName'));
      return;
    }
    setError(null);
    setBalanceWarning(null);
    setPhase('building');
    try {
      // Lazy-load: this is the FIRST place in the panel's render tree
      // that pulls Mesh in. The dynamic import keeps the ~5 MB WASM out
      // of cold-page loads of every other route — the lead-only,
      // passed-proposal-only nature of this panel means it's safe to
      // pay the chunk cost at click time.
      const [{ MeshTxBuilder }, { BrowserWallet }] = await Promise.all([
        import('@meshsdk/transaction'),
        import('@meshsdk/wallet'),
      ]);

      // CIP-95-enabled wallet — the SAME extension shape used for the
      // proof-of-control flow (lib/cip95DrepLink.ts). The vote tx
      // doesn't strictly REQUIRE CIP-95, but enabling it ensures the
      // wallet exposes the DRep-credential signing path that
      // CIP-1694 voting needs on wallets that gate it.
      const wallet = (await BrowserWallet.enable(walletName, [95])) as unknown as VoteWallet;

      // Pre-flight: check there's enough ADA in the wallet to cover a
      // vote tx fee. This is a USER-FACING warning — we do not block
      // the build, because Mesh's coin selection might still find a
      // workable set and the wallet will refuse to sign if it can't.
      const utxos = await wallet.getUtxos();
      const lovelace = totalLovelace(utxos as unknown[]);
      if (lovelace < MIN_LOVELACE_FOR_VOTE) {
        setBalanceWarning(t('committeeSubmit.errors.lowBalance'));
      }

      const unsignedTx = await buildUnsignedVoteTx(
        {
          drepId,
          actionId,
          position: readiness.payload.position,
          anchorUrl: readiness.payload.anchorUrl,
          anchorHash: readiness.payload.anchorHash,
          wallet,
        },
        { MeshTxBuilder: MeshTxBuilder as unknown as Parameters<typeof buildUnsignedVoteTx>[1]['MeshTxBuilder'] },
      );

      setPhase('signing');
      // `partialSign: false` — this is a single-signer DRep vote tx, so
      // the wallet MUST add a witness covering the body (not "I'm one
      // of many"). A `true` here would produce a tx the network
      // rejects.
      const signedTx = await wallet.signTx(unsignedTx, false);

      setPhase('submitting');
      const txHash = await wallet.submitTx(signedTx);
      setBroadcastTxHash(txHash);

      setPhase('recording');
      // The receipt records the txHash on the backend. `confirmedRealMainnetVote`
      // is the boolean-literal acknowledgement the backend insists on
      // when stage='test' — sending it on prod is harmless (backend ignores).
      receipt.mutate(
        { txHash, confirmedRealMainnetVote: true },
        {
          onSuccess: () => setPhase('idle'),
          onError: (err) => {
            setPhase('idle');
            // The tx was already broadcast — surface the receipt-record
            // error inline but DON'T retry the broadcast.
            setError(
              t('committeeSubmit.errors.receiptFailed', {
                txHash, message: (err as Error)?.message ?? 'unknown',
              }),
            );
          },
        },
      );
    } catch (err) {
      setPhase('idle');
      const msg = (err as Error)?.message ?? '';
      // Most wallets surface a user-declined-signature error with the
      // word "Declined" or code 2. Treat anything that LOOKS like a
      // wallet decline as "vote not cast" — no auto-retry; the user
      // hits the button again if they meant to sign.
      if (/declin|denie|user reject|2/i.test(msg)) {
        setError(t('committeeSubmit.errors.declined'));
      } else {
        setError(t('committeeSubmit.errors.broadcastFailed', { message: msg || 'unknown' }));
      }
    }
  };

  const phaseLabel = (): string => {
    switch (phase) {
      case 'building':   return t('committeeSubmit.phase.building');
      case 'signing':    return t('committeeSubmit.phase.signing');
      case 'submitting': return t('committeeSubmit.phase.submitting');
      case 'recording':  return t('committeeSubmit.phase.recording');
      default:           return t('committeeSubmit.button.signAndBroadcast');
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>{t('committeeRoom.submit.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {/* Red safety warning at the TOP, before any prepare action — this
            is the FIRST thing the user sees on the test environment. On
            prod the entire block is hidden. */}
        {isTest && (
          <div
            role="alert"
            className="rounded-token-md border-2 border-[var(--danger)] bg-[var(--danger-soft,rgba(220,38,38,0.08))] p-3 text-[12.5px] space-y-2"
          >
            <p className="font-semibold text-[var(--danger)]">
              {t('committeeSubmit.testWarning.title')}
            </p>
            <p>{t('committeeSubmit.testWarning.body')}</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={acknowledgedTest}
                onChange={(e) => setAcknowledgedTest(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t('committeeSubmit.testWarning.acknowledge')}</span>
            </label>
          </div>
        )}

        <label className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          {t('committeeRoom.submit.overrideLabel')}
        </label>
        <Button size="sm" variant="secondary" disabled={prepare.isPending} onClick={onPrepare}>
          {prepare.isPending ? t('committeeRoom.submit.preparing') : t('committeeRoom.submit.prepare')}
        </Button>
        {prepare.isError && (
          <p className="text-[12px] text-[var(--danger)]">{(prepare.error as Error)?.message ?? t('committeeRoom.submit.prepareError')}</p>
        )}

        {readiness && (
          <div className="space-y-2 rounded-token-md border border-[var(--border-default)] p-3 text-[12.5px]">
            <div><span className="text-[var(--text-secondary)]">{t('committeeRoom.submit.position')}</span> {readiness.payload.position} ({t('committeeRoom.submit.voteKind', { voteKind: readiness.payload.voteKind })})</div>
            <div className="break-all"><span className="text-[var(--text-secondary)]">{t('committeeRoom.submit.anchor')}</span> {readiness.payload.anchorUrl ?? t('committeeRoom.submit.anchorNone')}</div>
            <div className="break-all"><span className="text-[var(--text-secondary)]">{t('committeeRoom.submit.hash')}</span> <span className="font-mono">{readiness.payload.anchorHash ?? t('committeeRoom.submit.hashNone')}</span></div>
            <p className={readiness.broadcastAllowed ? 'text-[var(--success)]' : 'text-[var(--text-secondary)]'}>{readiness.message}</p>

            {readiness.broadcastAllowed ? (
              <div className="space-y-2">
                <Button
                  size="sm" variant="primary"
                  disabled={!canSign}
                  onClick={() => { void onSignAndBroadcast(); }}
                >
                  {phaseLabel()}
                </Button>
                {balanceWarning && (
                  <p className="text-[12px] text-[var(--warning,#a16207)]">{balanceWarning}</p>
                )}
                {broadcastTxHash && (
                  <p className="text-[12px] text-[var(--success)] break-all">
                    {t('committeeSubmit.broadcastSuccess', { txHash: broadcastTxHash })}
                  </p>
                )}
                {receipt.isSuccess && (
                  <p className="text-[var(--success)]">{t('committeeRoom.submit.recorded')}</p>
                )}
                {error && (
                  <p className="text-[12px] text-[var(--danger)]">{error}</p>
                )}
                {!walletName && (
                  <p className="text-[12px] text-[var(--text-secondary)]">
                    {t('committeeSubmit.errors.noWalletName')}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-[var(--text-secondary)]">
                {isTest
                  ? t('committeeSubmit.notAvailable')
                  : t('committeeRoom.submit.testDisabled')}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
