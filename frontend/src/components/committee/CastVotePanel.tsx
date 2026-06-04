import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useCastCommitteeVote } from '@/hooks/useCommitteeVotes';
import type { CommitteeCastVote } from '@/types/committee';

const OPTIONS: { vote: CommitteeCastVote; labelKey: string; variant: 'primary' | 'destructive' | 'secondary' }[] = [
  { vote: 'Agree', labelKey: 'committeeRoom.cast.agree', variant: 'primary' },
  { vote: 'Disagree', labelKey: 'committeeRoom.cast.disagree', variant: 'destructive' },
  { vote: 'Abstain', labelKey: 'committeeRoom.cast.abstain', variant: 'secondary' },
];

/** Agree / Disagree / Abstain — each click triggers a fresh wallet signature. */
export function CastVotePanel({
  drepId,
  actionId,
  myVote,
  disabled,
}: {
  drepId: string;
  actionId: string;
  myVote?: CommitteeCastVote;
  disabled?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const cast = useCastCommitteeVote(drepId, actionId);
  const [pending, setPending] = useState<CommitteeCastVote | null>(null);

  const onCast = (vote: CommitteeCastVote): void => {
    setPending(vote);
    cast.mutate({ vote }, { onSettled: () => setPending(null) });
  };

  return (
    <div>
      <div className="flex gap-2">
        {OPTIONS.map((o) => (
          <Button
            key={o.vote}
            variant={myVote === o.vote ? o.variant : 'secondary'}
            size="sm"
            disabled={disabled || cast.isPending}
            aria-pressed={myVote === o.vote}
            onClick={() => onCast(o.vote)}
          >
            {pending === o.vote ? t('committeeRoom.cast.signing') : t(o.labelKey)}
            {myVote === o.vote ? ' ✓' : ''}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
        {t('committeeRoom.cast.help')}
      </p>
      {cast.isError && (
        <p className="mt-1 text-[12.5px] text-[var(--danger)]">
          {(cast.error as Error)?.message ?? t('committeeRoom.cast.error')}
        </p>
      )}
    </div>
  );
}
