import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthStore, useIsCommitteeMember, useIsAuthenticated } from '@/stores/authStore';
import { useRegisterCommittee } from '@/hooks/useCommitteeMembership';

const inputCls =
  'w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-[13px] focus:outline-none focus-visible:shadow-token-focus';

export function CommitteeLanding(): React.ReactElement {
  const isAuthed = useIsAuthenticated();
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
      ) : isAuthed ? (
        <RegisterCommitteeCard />
      ) : (
        <Card>
          <CardContent>
            <p className="text-[13.5px] text-[var(--text-secondary)]">
              Connect your wallet (top-right) to register a DRep committee or join one.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RegisterCommitteeCard(): React.ReactElement {
  const register = useRegisterCommittee();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [created, setCreated] = useState<{ drepId: string } | null>(null);

  if (created) {
    return (
      <Card>
        <CardHeader><CardTitle>Committee created ✓</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-[13.5px]">
          <p className="text-[var(--text-secondary)]">
            Your committee is registered. <strong className="text-[var(--text-primary)]">Reconnect your wallet</strong> (top-right)
            to activate your lead-DRep role, then manage members, set your voting rules, and open proposals.
          </p>
          <Link to={`/committee/${encodeURIComponent(created.drepId)}`} className="text-[var(--brand-primary)] hover:underline">
            Go to your committee →
          </Link>
        </CardContent>
      </Card>
    );
  }

  const submit = (): void => {
    if (!name.trim() || !description.trim()) return;
    register.mutate(
      { committeeName: name.trim(), description: description.trim() },
      { onSuccess: (c) => setCreated({ drepId: c.drepId }) },
    );
  };

  return (
    <Card>
      <CardHeader><CardTitle>Register a DRep committee</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          Become a lead DRep and create a committee. A wallet can belong to only one committee.
        </p>
        <label className="block text-[12px] text-[var(--text-secondary)]">
          Committee name
          <input className={`${inputCls} mt-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cardano Builders Collective" />
        </label>
        <label className="block text-[12px] text-[var(--text-secondary)]">
          Description
          <textarea className={`${inputCls} mt-1 min-h-[90px] resize-y`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this committee stands for…" />
        </label>
        <Button size="sm" variant="primary" disabled={!name.trim() || !description.trim() || register.isPending} onClick={submit}>
          {register.isPending ? 'Creating…' : 'Create committee'}
        </Button>
        {register.isError && (
          <p className="text-[12px] text-[var(--danger)]">
            {(register.error as Error)?.message ?? 'Could not register. You may already lead a committee.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
