import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useCastCommitteeVote } from '@/hooks/useCommitteeVotes';
import type { CommitteeCastVote } from '@/types/committee';

const OPTIONS: { vote: CommitteeCastVote; label: string; variant: 'primary' | 'destructive' | 'secondary' }[] = [
  { vote: 'Agree', label: 'Agree', variant: 'primary' },
  { vote: 'Disagree', label: 'Disagree', variant: 'destructive' },
  { vote: 'Abstain', label: 'Abstain', variant: 'secondary' },
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
            {pending === o.vote ? 'Signing…' : o.label}
            {myVote === o.vote ? ' ✓' : ''}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
        Each vote is signed with your wallet — expect a signature prompt. You can change your vote until the proposal is closed.
      </p>
      {cast.isError && (
        <p className="mt-1 text-[12.5px] text-[var(--danger)]">
          {(cast.error as Error)?.message ?? 'Could not record your vote. Please try again.'}
        </p>
      )}
    </div>
  );
}
