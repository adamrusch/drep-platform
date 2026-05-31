import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  useUpdateVotingConfig,
  useAddCommitteeMember,
  useStoreIpfsKey,
  useIpfsKeyStatus,
  useCommitteeDetails,
  useUpdateCommittee,
} from '@/hooks/useCommitteeMembership';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import type { RationaleMode } from '@/types/committee';

const MODES: { value: RationaleMode; label: string }[] = [
  { value: 'lead', label: 'Lead authors' },
  { value: 'assigned', label: 'Lead assigns an editor' },
  { value: 'collaborative', label: 'Collaborative (all members)' },
];

const inputCls =
  'w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] focus:outline-none focus-visible:shadow-token-focus';

export function CommitteeSettings({ drepId }: { drepId: string }): React.ReactElement {
  const config = useUpdateVotingConfig(drepId);
  const addMember = useAddCommitteeMember(drepId);
  const storeKey = useStoreIpfsKey(drepId);
  const keyStatus = useIpfsKeyStatus(drepId);

  const [thresholdPct, setThresholdPct] = useState(67);
  const [rationaleMode, setRationaleMode] = useState<RationaleMode>('lead');
  const [assignedEditor, setAssignedEditor] = useState('');
  const [memberWallet, setMemberWallet] = useState('');
  const [ipfsKey, setIpfsKey] = useState('');

  return (
    <div className="space-y-4">
      <CommitteeDetailsCard drepId={drepId} />
      <Card>
      <CardHeader><CardTitle>Committee settings</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        {/* Voting config */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium text-[var(--text-primary)]">Voting</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] text-[var(--text-secondary)]">
              Threshold % (≥ 51)
              <input
                type="number" min={51} max={100} value={thresholdPct}
                onChange={(e) => setThresholdPct(Number(e.target.value))}
                className={`${inputCls} mt-1 w-28`}
              />
            </label>
            <label className="text-[12px] text-[var(--text-secondary)]">
              Rationale mode
              <select value={rationaleMode} onChange={(e) => setRationaleMode(e.target.value as RationaleMode)} className={`${inputCls} mt-1`}>
                {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            {rationaleMode === 'assigned' && (
              <label className="flex-1 text-[12px] text-[var(--text-secondary)]">
                Assigned editor wallet
                <input value={assignedEditor} onChange={(e) => setAssignedEditor(e.target.value)} className={`${inputCls} mt-1 font-mono`} />
              </label>
            )}
            <Button
              size="sm" variant="primary" disabled={config.isPending}
              onClick={() => config.mutate({ thresholdPct, rationaleMode, ...(rationaleMode === 'assigned' ? { assignedEditor } : {}) })}
            >
              {config.isPending ? 'Signing…' : 'Save voting config'}
            </Button>
          </div>
          {config.isError && <p className="text-[12px] text-[var(--danger)]">{(config.error as Error)?.message}</p>}
        </section>

        {/* Add member */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium text-[var(--text-primary)]">Add member</h3>
          <div className="flex flex-wrap items-end gap-2">
            <input value={memberWallet} onChange={(e) => setMemberWallet(e.target.value)} placeholder="member wallet address" className={`${inputCls} flex-1 font-mono`} />
            <Button
              size="sm" variant="secondary" disabled={!memberWallet.trim() || addMember.isPending}
              onClick={() => addMember.mutate({ walletAddress: memberWallet.trim() }, { onSuccess: () => setMemberWallet('') })}
            >
              {addMember.isPending ? 'Signing…' : 'Add'}
            </Button>
          </div>
          <p className="text-[11.5px] text-[var(--text-secondary)]">A wallet can belong to only one committee.</p>
          {addMember.isError && <p className="text-[12px] text-[var(--danger)]">{(addMember.error as Error)?.message}</p>}
        </section>

        {/* IPFS key */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium text-[var(--text-primary)]">IPFS pinning key</h3>
          <p className="text-[11.5px] text-[var(--text-secondary)]">
            {keyStatus.data?.stored ? 'A key is stored (encrypted).' : 'No key stored. Recommended: a Blockfrost IPFS project id.'}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <input type="password" value={ipfsKey} onChange={(e) => setIpfsKey(e.target.value)} placeholder="IPFS project id" className={`${inputCls} flex-1`} />
            <Button
              size="sm" variant="secondary" disabled={!ipfsKey.trim() || storeKey.isPending}
              onClick={() => storeKey.mutate({ ipfsProjectId: ipfsKey.trim() }, { onSuccess: () => setIpfsKey('') })}
            >
              {storeKey.isPending ? 'Saving…' : 'Save key'}
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
    </div>
  );
}

/** "Committee details" card — lets the lead DRep edit the committee name and
 *  description (PUT /drep/{drepId}). Gated on the connected wallet being the
 *  lead even though the parent already gates: defense-in-depth keeps the form
 *  off the screen for non-leads in any future caller. */
function CommitteeDetailsCard({ drepId }: { drepId: string }): React.ReactElement | null {
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const addToast = useUiStore((s) => s.addToast);
  const details = useCommitteeDetails(drepId);
  const update = useUpdateCommittee(drepId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Pre-fill once the committee record loads. Refill on subsequent loads
  // (e.g. another tab edits the committee) so the form stays in sync.
  useEffect(() => {
    if (details.data) {
      setName(details.data.committeeName);
      setDescription(details.data.description);
    }
  }, [details.data]);

  if (details.isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>Committee details</CardTitle></CardHeader>
        <CardContent>
          <p className="text-[13px] text-[var(--text-secondary)]">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  if (details.isError || !details.data) {
    return (
      <Card>
        <CardHeader><CardTitle>Committee details</CardTitle></CardHeader>
        <CardContent>
          <p className="text-[13px] text-[var(--danger)]">
            {(details.error as Error)?.message ?? 'Could not load committee details.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  // Lead-only gate — hide the editor for non-leads.
  const isLead = Boolean(walletAddress) && walletAddress === details.data.leadWallet;
  if (!isLead) return null;

  const dirty =
    name.trim() !== details.data.committeeName ||
    description.trim() !== details.data.description;
  const canSave =
    dirty && name.trim().length > 0 && description.trim().length > 0 && !update.isPending;

  const submit = (): void => {
    const body: { committeeName?: string; description?: string } = {};
    if (name.trim() !== details.data?.committeeName) body.committeeName = name.trim();
    if (description.trim() !== details.data?.description) body.description = description.trim();
    if (Object.keys(body).length === 0) return;
    update.mutate(body, {
      onSuccess: () => {
        addToast({ title: 'Committee details updated', variant: 'success' });
      },
      onError: (err) => {
        addToast({
          title: 'Could not update committee',
          description: (err as Error)?.message,
          variant: 'error',
        });
      },
    });
  };

  return (
    <Card>
      <CardHeader><CardTitle>Committee details</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <label className="block text-[12px] text-[var(--text-secondary)]">
          Committee name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${inputCls} mt-1`}
            placeholder="Committee name"
          />
        </label>
        <label className="block text-[12px] text-[var(--text-secondary)]">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputCls} mt-1 min-h-[90px] resize-y`}
            placeholder="What this committee stands for…"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={!canSave} onClick={submit}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          {dirty && !update.isPending && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(details.data?.committeeName ?? '');
                setDescription(details.data?.description ?? '');
              }}
            >
              Reset
            </Button>
          )}
        </div>
        {update.isError && (
          <p className="text-[12px] text-[var(--danger)]">
            {(update.error as Error)?.message ?? 'Could not update committee.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
