import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthStore, useIsCommitteeMember, useIsAuthenticated } from '@/stores/authStore';
import { useRegisterCommittee } from '@/hooks/useCommitteeMembership';
import { pasteDrepLinkAllowed } from '@/lib/stage';

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
  const walletName = useAuthStore((s) => s.walletName);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [drepId, setDrepId] = useState('');
  const [drepKey, setDrepKey] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectErr, setDetectErr] = useState<string | null>(null);
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

  // Best-effort: read the wallet's DRep key via CIP-95 (proves control). Falls
  // back to a pasted drep id if the wallet doesn't support it.
  const detect = async (): Promise<void> => {
    setDetecting(true);
    setDetectErr(null);
    try {
      const cardano = (
        window as unknown as {
          cardano?: Record<string, { enable: (o?: unknown) => Promise<{ cip95?: { getPubDRepKey?: () => Promise<string> } }> }>;
        }
      ).cardano;
      const connector = walletName ? cardano?.[walletName] : undefined;
      if (!connector) throw new Error('Reconnect your wallet first.');
      const api = await connector.enable({ extensions: [{ cip: 95 }] });
      const key = await api?.cip95?.getPubDRepKey?.();
      if (!key) throw new Error('This wallet did not return a DRep key (CIP-95 not supported?). Paste your drep id instead.');
      setDrepKey(key);
    } catch (e) {
      setDetectErr((e as Error)?.message ?? 'Could not read your DRep key.');
    } finally {
      setDetecting(false);
    }
  };

  const hasDrep = Boolean(drepKey) || /^drep1[0-9a-z]{10,}$/.test(drepId.trim());

  const submit = (): void => {
    if (!name.trim() || !description.trim() || !hasDrep) return;
    register.mutate(
      {
        committeeName: name.trim(),
        description: description.trim(),
        ...(drepKey ? { drepKey } : { drepId: drepId.trim() }),
      },
      { onSuccess: (c) => setCreated({ drepId: c.drepId }) },
    );
  };

  return (
    <Card>
      <CardHeader><CardTitle>Register a DRep committee</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          Create a committee for your registered DRep. A wallet can lead only one committee, and each DRep has one committee.
        </p>
        <label className="block text-[12px] text-[var(--text-secondary)]">
          Committee name
          <input className={`${inputCls} mt-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cardano Builders Collective" />
        </label>
        <label className="block text-[12px] text-[var(--text-secondary)]">
          Description
          <textarea className={`${inputCls} mt-1 min-h-[90px] resize-y`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this committee stands for…" />
        </label>

        {/* DRep binding — the committee governs this DRep's on-chain votes */}
        <div className="space-y-2">
          <div className="text-[12px] text-[var(--text-secondary)]">Your DRep</div>
          {drepKey ? (
            <div className="flex items-center justify-between rounded-token-md border border-[var(--border-default)] px-3 py-1.5 text-[12px]">
              <span className="text-[var(--success)]">DRep key detected from your wallet ✓</span>
              <button className="text-[var(--brand-primary)] hover:underline" onClick={() => setDrepKey(null)}>change</button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                {pasteDrepLinkAllowed() && (
                  <input className={`${inputCls} flex-1 font-mono`} value={drepId} onChange={(e) => setDrepId(e.target.value)} placeholder="drep1…" />
                )}
                <Button size="sm" variant="secondary" disabled={detecting} onClick={() => void detect()}>
                  {detecting ? 'Reading…' : 'Use wallet (CIP-95)'}
                </Button>
              </div>
              <p className="text-[11px] text-[var(--text-secondary)]">
                {pasteDrepLinkAllowed()
                  ? 'Paste your registered drep id, or detect it from your wallet. Your DRep must already be registered on-chain.'
                  : 'Connect your CIP-95 wallet so we can verify you control the DRep. Your DRep must already be registered on-chain.'}
              </p>
              {detectErr && <p className="text-[11.5px] text-[var(--danger)]">{detectErr}</p>}
            </>
          )}
        </div>

        <Button size="sm" variant="primary" disabled={!name.trim() || !description.trim() || !hasDrep || register.isPending} onClick={submit}>
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
