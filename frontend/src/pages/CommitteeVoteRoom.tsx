import { useParams, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { useAuthStore } from '@/stores/authStore';
import { useIsCommitteeMember } from '@/stores/authStore';
import {
  useCommitteeVote,
  useCloseCommitteeVote,
  useFailCommitteeVote,
  useWithdrawProposal,
} from '@/hooks/useCommitteeVotes';
import { VoteTallyDonut } from '@/components/committee/VoteTallyDonut';
import { CastVotePanel } from '@/components/committee/CastVotePanel';

function shortWallet(w: string): string {
  return w.length > 16 ? `${w.slice(0, 10)}…${w.slice(-6)}` : w;
}

export function CommitteeVoteRoom(): React.ReactElement {
  const { drepId = '', actionId = '' } = useParams<{ drepId: string; actionId: string }>();
  const wallet = useAuthStore((s) => s.walletAddress);
  const isMember = useIsCommitteeMember();
  const { data, isLoading, isError } = useCommitteeVote(drepId, actionId);

  const close = useCloseCommitteeVote(drepId, actionId);
  const fail = useFailCommitteeVote(drepId, actionId);
  const withdraw = useWithdrawProposal(drepId, actionId);

  if (isLoading) return <p className="text-[var(--text-secondary)]">Loading proposal…</p>;
  if (isError || !data) {
    return (
      <Card>
        <CardContent>
          <p className="text-[var(--text-secondary)]">
            No proposal found for this governance action yet.
          </p>
          <Link to={`/committee/${encodeURIComponent(drepId)}`} className="text-[var(--brand-primary)] hover:underline">
            ← Back to committee
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { proposal, casts, tally } = data;
  const isOpen = proposal.status === 'open';
  const myVote = wallet ? casts.find((c) => c.voterWallet === wallet)?.vote : undefined;
  const isProposerOrLead = wallet === proposal.proposerWallet; // lead override resolved server-side
  const busy = close.isPending || fail.isPending || withdraw.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to={`/committee/${encodeURIComponent(drepId)}`} className="text-[13px] text-[var(--brand-primary)] hover:underline">
          ← Committee proposals
        </Link>
        <StatusPill status={proposal.status === 'epoch_finalized' ? 'expired' : proposal.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Proposed DRep position: {proposal.proposedPosition}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-[13px] text-[var(--text-secondary)]">
            Action <span className="font-mono">{actionId}</span> · proposed by {shortWallet(proposal.proposerWallet)} ·
            threshold {proposal.thresholdPct}% of active voters · quorum {proposal.quorum}
          </p>
          <VoteTallyDonut tally={tally} />
          <p className="mt-3 text-[12.5px] text-[var(--text-secondary)]">
            {tally.isPassing
              ? 'Currently passing — any member may close it as passed.'
              : 'Not currently passing.'}
          </p>
        </CardContent>
      </Card>

      {isOpen && isMember && (
        <Card>
          <CardHeader><CardTitle>Cast your vote</CardTitle></CardHeader>
          <CardContent>
            <CastVotePanel drepId={drepId} actionId={actionId} myVote={myVote} disabled={busy} />
          </CardContent>
        </Card>
      )}

      {isOpen && isMember && (
        <Card>
          <CardHeader><CardTitle>Resolve</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={!tally.canCloseAsPass || busy}
                onClick={() => close.mutate()}
              >
                {close.isPending ? 'Signing…' : 'Close as passed'}
              </Button>
              {isProposerOrLead && (
                <>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={() => fail.mutate()}>
                    {fail.isPending ? 'Signing…' : 'Close as failed'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => withdraw.mutate()}>
                    {withdraw.isPending ? 'Signing…' : 'Withdraw'}
                  </Button>
                </>
              )}
            </div>
            {!tally.canCloseAsPass && (
              <p className="text-[12px] text-[var(--text-secondary)]">
                "Close as passed" unlocks once quorum is met and the proposal is passing.
              </p>
            )}
            <p className="text-[12px] text-[var(--text-secondary)]">
              Close-as-failed and withdraw are limited to the proposer or the lead DRep.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Rationale</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-2 text-[13px] text-[var(--text-secondary)]">
            A rationale must be authored and finalized before the vote is submitted on-chain.
          </p>
          <Link
            to={`/committee/${encodeURIComponent(drepId)}/votes/${encodeURIComponent(actionId)}/rationale`}
            className="text-[var(--brand-primary)] hover:underline text-[13.5px]"
          >
            {data.hasRationaleDraft ? 'Continue the rationale →' : 'Start the rationale →'}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
