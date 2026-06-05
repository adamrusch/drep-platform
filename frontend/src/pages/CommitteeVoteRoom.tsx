import { Trans, useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { useAuthStore } from '@/stores/authStore';
import { useIsMemberOfCommittee } from '@/stores/authStore';
import {
  useCommitteeVote,
  useCloseCommitteeVote,
  useFailCommitteeVote,
  useWithdrawProposal,
} from '@/hooks/useCommitteeVotes';
import { VoteTallyDonut } from '@/components/committee/VoteTallyDonut';
import { CastVotePanel } from '@/components/committee/CastVotePanel';
import { SubmitVotePanel } from '@/components/committee/SubmitVotePanel';
import { isTestStage } from '@/lib/stage';

function shortWallet(w: string): string {
  return w.length > 16 ? `${w.slice(0, 10)}…${w.slice(-6)}` : w;
}

export function CommitteeVoteRoom(): React.ReactElement {
  const { t } = useTranslation();
  const { drepId = '', actionId = '' } = useParams<{ drepId: string; actionId: string }>();
  const wallet = useAuthStore((s) => s.walletAddress);
  const isMember = useIsMemberOfCommittee(drepId);
  const { data, isLoading, isError } = useCommitteeVote(drepId, actionId);

  const close = useCloseCommitteeVote(drepId, actionId);
  const fail = useFailCommitteeVote(drepId, actionId);
  const withdraw = useWithdrawProposal(drepId, actionId);

  if (isLoading) return <p className="text-[var(--text-secondary)]">{t('committeeRoom.room.loadingProposal')}</p>;
  if (isError || !data) {
    return (
      <Card>
        <CardContent>
          <p className="text-[var(--text-secondary)]">
            {t('committeeRoom.room.notFound')}
          </p>
          <Link to={`/committee/${encodeURIComponent(drepId)}`} className="text-[var(--brand-primary)] hover:underline">
            {t('committeeRoom.room.backToCommittee')}
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
      {isTestStage() && (
        <div className="rounded-token-md border border-[var(--border-strong)] bg-[var(--bg-muted)] px-3 py-2 text-[12.5px] text-[var(--text-secondary)]">
          <Trans i18nKey="committeeRoom.room.testBanner" components={{ strong: <strong className="text-[var(--text-primary)]" /> }} />
        </div>
      )}
      <div className="flex items-center justify-between">
        <Link to={`/committee/${encodeURIComponent(drepId)}`} className="text-[13px] text-[var(--brand-primary)] hover:underline">
          {t('committeeRoom.room.committeeProposals')}
        </Link>
        <StatusPill status={proposal.status === 'epoch_finalized' ? 'expired' : proposal.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('committeeRoom.room.proposedPosition', { position: t(`committeeRoom.list.position.${proposal.proposedPosition}`) })}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-[13px] text-[var(--text-secondary)]">
            <Trans
              i18nKey="committeeRoom.room.actionLine"
              values={{
                actionId,
                proposer: shortWallet(proposal.proposerWallet),
                x: proposal.approvalThreshold,
                n: proposal.memberCount,
              }}
              components={{ mono: <span className="font-mono" />, strong: <strong className="text-[var(--text-primary)]" /> }}
            />
          </p>
          <VoteTallyDonut tally={tally} />
          <p className="mt-3 text-[12.5px] text-[var(--text-secondary)]">
            {tally.isApproved
              ? t('committeeRoom.room.approved')
              : t('committeeRoom.room.notApproved', { count: tally.agreeNeeded })}
          </p>
        </CardContent>
      </Card>

      {isOpen && isMember && (
        <Card>
          <CardHeader><CardTitle>{t('committeeRoom.room.castTitle')}</CardTitle></CardHeader>
          <CardContent>
            <CastVotePanel drepId={drepId} actionId={actionId} myVote={myVote} disabled={busy} />
          </CardContent>
        </Card>
      )}

      {isOpen && isMember && (
        <Card>
          <CardHeader><CardTitle>{t('committeeRoom.room.resolveTitle')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={!tally.canCloseAsPass || busy}
                onClick={() => close.mutate()}
              >
                {close.isPending ? t('committeeRoom.room.signing') : t('committeeRoom.room.closeAsPassed')}
              </Button>
              {isProposerOrLead && (
                <>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={() => fail.mutate()}>
                    {fail.isPending ? t('committeeRoom.room.signing') : t('committeeRoom.room.closeAsFailed')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => withdraw.mutate()}>
                    {withdraw.isPending ? t('committeeRoom.room.signing') : t('committeeRoom.room.withdraw')}
                  </Button>
                </>
              )}
            </div>
            {!tally.canCloseAsPass && (
              <p className="text-[12px] text-[var(--text-secondary)]">
                {t('committeeRoom.room.closeLockedHint', { x: tally.approvalThreshold, n: tally.memberCount })}
              </p>
            )}
            <p className="text-[12px] text-[var(--text-secondary)]">
              {t('committeeRoom.room.resolveLimited')}
            </p>
          </CardContent>
        </Card>
      )}

      {proposal.status === 'passed' && isMember && (
        <SubmitVotePanel drepId={drepId} actionId={actionId} />
      )}

      <Card>
        <CardHeader><CardTitle>{t('committeeRoom.room.rationaleTitle')}</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-2 text-[13px] text-[var(--text-secondary)]">
            {t('committeeRoom.room.rationaleHelp')}
          </p>
          <Link
            to={`/committee/${encodeURIComponent(drepId)}/votes/${encodeURIComponent(actionId)}/rationale`}
            className="text-[var(--brand-primary)] hover:underline text-[13.5px]"
          >
            {data.hasRationaleDraft ? t('committeeRoom.room.continueRationale') : t('committeeRoom.room.startRationale')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
