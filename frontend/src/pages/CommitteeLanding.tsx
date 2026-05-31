import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { useAuthStore, useIsCommitteeMember } from '@/stores/authStore';

export function CommitteeLanding(): React.ReactElement {
  const isMember = useIsCommitteeMember();
  const drepId = useAuthStore((s) => s.drepId);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">DRep Committees</h1>
      <p className="max-w-2xl text-[14px] text-[var(--text-secondary)]">
        Committees let a lead DRep and their members deliberate and vote internally on each
        governance action — propose a position, vote with a configurable supermajority, author a
        shared rationale, and submit the vote on-chain.
      </p>

      {isMember && drepId ? (
        <Card>
          <CardHeader><CardTitle>Your committee</CardTitle></CardHeader>
          <CardContent>
            <Link to={`/committee/${encodeURIComponent(drepId)}`} className="text-[var(--brand-primary)] hover:underline">
              Go to your committee's proposals →
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <p className="text-[13.5px] text-[var(--text-secondary)]">
              You're not part of a committee yet. Register as a lead DRep from your dashboard, or ask a
              lead DRep to add your wallet to theirs.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
