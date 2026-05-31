import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  useUpdateVotingConfig,
  useAddCommitteeMember,
  useStoreIpfsKey,
  useIpfsKeyStatus,
} from '@/hooks/useCommitteeMembership';
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
  );
}
