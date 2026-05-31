import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useSubmitVote, useSubmitReceipt, type SubmitReadiness } from '@/hooks/useCommitteeVotes';

/**
 * On-chain submission for a passed proposal (lead only). Prepares + validates
 * the CIP-1694 payload, then:
 *   - prod: the lead signs/broadcasts the vote tx with their wallet and records
 *     the resulting txHash here (the wallet-tx assembly is the integration point
 *     that needs a wallet + node to verify — see NOTE below).
 *   - non-prod: everything assembles but broadcast is disabled — the vote must
 *     be submitted from production.
 */
export function SubmitVotePanel({ drepId, actionId }: { drepId: string; actionId: string }): React.ReactElement {
  const prepare = useSubmitVote(drepId, actionId);
  const receipt = useSubmitReceipt(drepId, actionId);
  const [override, setOverride] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [readiness, setReadiness] = useState<SubmitReadiness | null>(null);

  const onPrepare = (): void => {
    prepare.mutate({ override }, { onSuccess: (r) => setReadiness(r as SubmitReadiness) });
  };

  return (
    <Card>
      <CardHeader><CardTitle>Submit on-chain</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          Proceed even without a finalized rationale (discouraged)
        </label>
        <Button size="sm" variant="secondary" disabled={prepare.isPending} onClick={onPrepare}>
          {prepare.isPending ? 'Preparing…' : 'Prepare submission'}
        </Button>
        {prepare.isError && (
          <p className="text-[12px] text-[var(--danger)]">{(prepare.error as Error)?.message ?? 'Could not prepare.'}</p>
        )}

        {readiness && (
          <div className="space-y-2 rounded-token-md border border-[var(--border-default)] p-3 text-[12.5px]">
            <div><span className="text-[var(--text-secondary)]">Position:</span> {readiness.payload.position} (voteKind {readiness.payload.voteKind})</div>
            <div className="break-all"><span className="text-[var(--text-secondary)]">Anchor:</span> {readiness.payload.anchorUrl ?? '— none —'}</div>
            <div className="break-all"><span className="text-[var(--text-secondary)]">Hash:</span> <span className="font-mono">{readiness.payload.anchorHash ?? '—'}</span></div>
            <p className={readiness.broadcastAllowed ? 'text-[var(--success)]' : 'text-[var(--text-secondary)]'}>{readiness.message}</p>

            {readiness.broadcastAllowed ? (
              <div className="space-y-2">
                {/* NOTE: the lead signs + broadcasts the CIP-1694 vote tx with
                    their wallet (Mesh/CSL), then records the resulting txHash
                    below. The wallet-tx assembly is the integration point that
                    must be verified against a wallet + node before relying on it. */}
                <input
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  placeholder="on-chain vote tx hash (64 hex)"
                  className="w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12px] font-mono focus:outline-none focus-visible:shadow-token-focus"
                />
                <Button
                  size="sm" variant="primary"
                  disabled={!/^[0-9a-fA-F]{64}$/.test(txHash) || receipt.isPending}
                  onClick={() => receipt.mutate({ txHash: txHash.trim() })}
                >
                  {receipt.isPending ? 'Recording…' : 'Record submission'}
                </Button>
                {receipt.isSuccess && <p className="text-[var(--success)]">Recorded ✓</p>}
                {receipt.isError && <p className="text-[var(--danger)]">{(receipt.error as Error)?.message}</p>}
              </div>
            ) : (
              <p className="text-[12px] text-[var(--text-secondary)]">
                On a test environment, broadcasting and recording are disabled. Promote to production to submit.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
