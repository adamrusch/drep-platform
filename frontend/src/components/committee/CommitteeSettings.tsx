import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  useUpdateVotingConfig,
  useAddCommitteeMember,
  useRemoveCommitteeMember,
  useCheckMembers,
  useStoreIpfsKey,
  useIpfsKeyStatus,
  useCommitteeDetails,
  useUpdateCommittee,
} from '@/hooks/useCommitteeMembership';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import type { CheckMemberResult, RationaleMode } from '@/types/committee';
import type { CommitteeMember } from '@/types';

const MODES: { value: RationaleMode; label: string }[] = [
  { value: 'lead', label: 'Lead authors' },
  { value: 'assigned', label: 'Lead assigns an editor' },
  { value: 'collaborative', label: 'Collaborative (all members)' },
];

const inputCls =
  'w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] focus:outline-none focus-visible:shadow-token-focus';

export function CommitteeSettings({ drepId }: { drepId: string }): React.ReactElement {
  return (
    <div className="space-y-4">
      <CommitteeDetailsCard drepId={drepId} />
      <RosterCard drepId={drepId} />
      <CommitteeOtherSettingsCard drepId={drepId} />
    </div>
  );
}

/**
 * Roster card: shows each member with their Active/Not-active status; the
 * Chair can add a member (with live status check + X-of-N restated for the new
 * size) or remove one (with X-of-N restated for the new smaller size). The
 * backend enforces the minimum-3 floor and the 1..N range.
 */
function RosterCard({ drepId }: { drepId: string }): React.ReactElement {
  const details = useCommitteeDetails(drepId);
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const addToast = useUiStore((s) => s.addToast);
  const addMember = useAddCommitteeMember(drepId);
  const removeMember = useRemoveCommitteeMember(drepId);
  const checkMembers = useCheckMembers();

  // Lead-only gate — non-leads see the roster but no add/remove controls.
  const isLead = Boolean(
    walletAddress && details.data && walletAddress === details.data.leadWallet,
  );

  // ---- Add-member form state ----
  const [newAddress, setNewAddress] = useState('');
  const [newCheck, setNewCheck] = useState<CheckMemberResult | null>(null);
  const [pendingX, setPendingX] = useState<number | null>(null);
  const [removalTarget, setRemovalTarget] = useState<string | null>(null);
  const [removalX, setRemovalX] = useState<number | null>(null);

  // Default X (when the lead opens the form) = current X (clamped to the new
  // N) — they're explicitly restating it but the current value is sensible.
  useEffect(() => {
    if (details.data && pendingX === null) {
      setPendingX(Math.min(details.data.approvalThreshold, details.data.memberCount + 1));
    }
  }, [details.data, pendingX]);

  useEffect(() => {
    if (details.data && removalTarget && removalX === null) {
      const newN = Math.max(1, details.data.memberCount - 1);
      setRemovalX(Math.min(details.data.approvalThreshold, newN));
    }
  }, [details.data, removalTarget, removalX]);

  // Live status check (on-blur via useEffect on trimmed value, debounced).
  useEffect(() => {
    const trimmed = newAddress.trim();
    if (trimmed.length === 0) {
      setNewCheck(null);
      return;
    }
    const t = setTimeout(() => {
      checkMembers.mutate(
        { addresses: [trimmed] },
        {
          onSuccess: (resp) => {
            setNewCheck(resp.results[0] ?? null);
          },
          onError: () => setNewCheck(null),
        },
      );
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newAddress]);

  if (details.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] text-[var(--text-secondary)]">Loading…</p>
        </CardContent>
      </Card>
    );
  }
  if (details.isError || !details.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] text-[var(--danger)]">
            {(details.error as Error)?.message ?? 'Could not load the committee.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const members = details.data.members;
  const N = details.data.memberCount;
  const currentX = details.data.approvalThreshold;

  const newCommitteeSize = N + 1;
  const addPossible =
    Boolean(newCheck?.valid) &&
    !members.some(
      (m) => m.walletAddress === (newCheck?.stakeAddress ?? newAddress.trim()),
    );
  const xValid =
    pendingX !== null &&
    Number.isInteger(pendingX) &&
    pendingX >= 1 &&
    pendingX <= newCommitteeSize;

  const submitAdd = (): void => {
    if (!addPossible || !xValid || pendingX === null) return;
    addMember.mutate(
      {
        walletAddress: newAddress.trim(),
        approvalThreshold: pendingX,
      },
      {
        onSuccess: () => {
          addToast({ title: 'Member added', variant: 'success' });
          setNewAddress('');
          setNewCheck(null);
        },
        onError: (err) => {
          addToast({
            title: 'Could not add member',
            description: (err as Error)?.message,
            variant: 'error',
          });
        },
      },
    );
  };

  const beginRemove = (target: CommitteeMember): void => {
    setRemovalTarget(target.walletAddress);
    setRemovalX(null); // recomputed by the effect above
  };

  const submitRemove = (target: string): void => {
    if (removalX === null) return;
    removeMember.mutate(
      { walletAddress: target, approvalThreshold: removalX },
      {
        onSuccess: () => {
          addToast({ title: 'Member removed', variant: 'success' });
          setRemovalTarget(null);
          setRemovalX(null);
        },
        onError: (err) => {
          addToast({
            title: 'Could not remove member',
            description: (err as Error)?.message,
            variant: 'error',
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[12.5px] text-[var(--text-primary)]">
          Approval rule: <strong>{currentX}</strong> of <strong>{N}</strong> members must
          vote Agree for Committee Approved.
        </p>
        <ul className="space-y-1.5">
          {members.map((m, i) => (
            <li
              key={m.walletAddress}
              className="flex flex-wrap items-center gap-3 rounded-token-md border border-[var(--border-default)] px-3 py-2 text-[12.5px]"
            >
              <span className="font-semibold text-[var(--text-primary)]">#{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-[var(--text-primary)]">
                  {m.role === 'lead_drep'
                    ? `Chair${m.displayName ? ` — ${m.displayName}` : ''}`
                    : (m.displayName ?? (m.active ? 'Active member' : 'Member'))}
                </div>
                <div className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
                  {m.walletAddress}
                </div>
              </div>
              <MemberActiveBadge active={Boolean(m.active)} />
              {isLead && m.role !== 'lead_drep' && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => beginRemove(m)}
                  disabled={removeMember.isPending}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>

        {/* Removal: restate X for the new size N-1 */}
        {isLead && removalTarget && (
          <div className="space-y-2 rounded-token-md border border-[var(--danger)] bg-[var(--bg-muted)] p-3">
            <p className="text-[12.5px] text-[var(--text-primary)]">
              Removing this member leaves <strong>{N - 1}</strong> members. Restate the
              approval rule for the new committee size:
            </p>
            <div className="flex items-end gap-2">
              <label className="text-[12px] text-[var(--text-secondary)]">
                X (1–{N - 1})
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, N - 1)}
                  value={removalX ?? ''}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isNaN(n)) return;
                    setRemovalX(Math.max(1, Math.min(N - 1, n)));
                  }}
                  className={`${inputCls} mt-1 w-24`}
                />
              </label>
              <Button
                size="sm"
                variant="destructive"
                disabled={removeMember.isPending || removalX === null || removalX < 1 || removalX > N - 1}
                onClick={() => submitRemove(removalTarget)}
              >
                {removeMember.isPending ? 'Signing…' : `Remove (sets ${removalX ?? '?'} of ${N - 1})`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRemovalTarget(null);
                  setRemovalX(null);
                }}
                disabled={removeMember.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Add member: type address → live status → restate X for the new size N+1 */}
        {isLead && (
          <section className="space-y-2 border-t border-[var(--border-default)] pt-3">
            <h3 className="text-[13px] font-medium text-[var(--text-primary)]">Add member</h3>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[240px] flex-1">
                <label className="block text-[12px] text-[var(--text-secondary)]">
                  Cardano address (payment or stake)
                  <input
                    value={newAddress}
                    onChange={(e) => setNewAddress(e.target.value)}
                    placeholder="addr1… or stake1…"
                    className={`${inputCls} mt-1 font-mono`}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <AddMemberStatus
                  result={newCheck}
                  alreadyMember={
                    newCheck?.valid
                      ? members.some(
                          (m) => m.walletAddress === (newCheck.stakeAddress ?? newAddress.trim()),
                        )
                      : false
                  }
                />
              </div>
              <label className="text-[12px] text-[var(--text-secondary)]">
                Restate X (1–{newCommitteeSize})
                <input
                  type="number"
                  min={1}
                  max={newCommitteeSize}
                  value={pendingX ?? ''}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isNaN(n)) return;
                    setPendingX(Math.max(1, Math.min(newCommitteeSize, n)));
                  }}
                  className={`${inputCls} mt-1 w-28`}
                />
              </label>
              <Button
                size="sm"
                variant="primary"
                disabled={!addPossible || !xValid || addMember.isPending}
                onClick={submitAdd}
              >
                {addMember.isPending ? 'Signing…' : `Add (sets ${pendingX ?? '?'} of ${newCommitteeSize})`}
              </Button>
            </div>
            <p className="text-[11.5px] text-[var(--text-secondary)]">
              Adding a member changes N to {newCommitteeSize}, so you must restate the X-of-N
              rule. The address can be a payment address (addr1…) or stake address (stake1…).
              "Not active" addresses are still addable — they just need to be invited to sign
              in.
            </p>
            {addMember.isError && (
              <p className="text-[12px] text-[var(--danger)]">
                {(addMember.error as Error)?.message}
              </p>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function MemberActiveBadge({ active }: { active: boolean }): React.ReactElement {
  return active ? (
    <span className="shrink-0 rounded-full bg-[var(--success)] px-2 py-0.5 text-[11px] font-medium text-white">
      Active ✓
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-[var(--danger)] px-2 py-0.5 text-[11px] font-medium text-[var(--danger)]">
      Not active ✗
    </span>
  );
}

function AddMemberStatus({
  result,
  alreadyMember,
}: {
  result: CheckMemberResult | null;
  alreadyMember: boolean;
}): React.ReactElement | null {
  if (!result) return null;
  if (!result.valid) {
    return (
      <p className="mt-1 text-[11.5px] text-[var(--danger)]">
        Not a valid Cardano payment or stake address.
      </p>
    );
  }
  if (alreadyMember) {
    return (
      <p className="mt-1 text-[11.5px] text-[var(--danger)]">
        This address is already a member of the committee.
      </p>
    );
  }
  return (
    <p className="mt-1 text-[11.5px] text-[var(--text-secondary)]">
      {result.active ? (
        <span className="text-[var(--success)]">✓ Active</span>
      ) : (
        <span className="text-[var(--danger)]">✗ Not active — they'll need to sign in</span>
      )}
      {result.displayName ? ` — ${result.displayName}` : ''}
    </p>
  );
}

/**
 * Other committee settings — rationale mode + IPFS pinning key. The voting
 * config still carries a `thresholdPct` field server-side for backwards compat
 * with older clients, but the X-of-N rule is the source of truth and is set
 * on the committee row itself (see roster section). We keep this UI lean on
 * the rationale-mode side and leave the threshold control off — adding/
 * removing a member is where the rule changes.
 */
function CommitteeOtherSettingsCard({ drepId }: { drepId: string }): React.ReactElement {
  const config = useUpdateVotingConfig(drepId);
  const storeKey = useStoreIpfsKey(drepId);
  const keyStatus = useIpfsKeyStatus(drepId);
  const details = useCommitteeDetails(drepId);
  const walletAddress = useAuthStore((s) => s.walletAddress);

  const [rationaleMode, setRationaleMode] = useState<RationaleMode>('lead');
  const [assignedEditor, setAssignedEditor] = useState('');
  const [ipfsKey, setIpfsKey] = useState('');

  // Lead-only gate.
  const isLead = useMemo(
    () => Boolean(walletAddress && details.data && walletAddress === details.data.leadWallet),
    [walletAddress, details.data],
  );
  if (!isLead) return <></>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Other settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Rationale mode */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium text-[var(--text-primary)]">Rationale authoring</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] text-[var(--text-secondary)]">
              Mode
              <select
                value={rationaleMode}
                onChange={(e) => setRationaleMode(e.target.value as RationaleMode)}
                className={`${inputCls} mt-1`}
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {rationaleMode === 'assigned' && (
              <label className="flex-1 text-[12px] text-[var(--text-secondary)]">
                Assigned editor wallet
                <input
                  value={assignedEditor}
                  onChange={(e) => setAssignedEditor(e.target.value)}
                  className={`${inputCls} mt-1 font-mono`}
                />
              </label>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={config.isPending}
              onClick={() =>
                config.mutate({
                  // The X-of-N approval rule lives on the committee row and is
                  // restated on member changes — the voting-config thresholdPct
                  // is a legacy informational field. We send a sentinel value
                  // (67) so the signature/message stays valid against the
                  // existing backend; the resolver no longer reads it.
                  thresholdPct: 67,
                  rationaleMode,
                  ...(rationaleMode === 'assigned' ? { assignedEditor } : {}),
                })
              }
            >
              {config.isPending ? 'Signing…' : 'Save rationale mode'}
            </Button>
          </div>
          {config.isError && (
            <p className="text-[12px] text-[var(--danger)]">{(config.error as Error)?.message}</p>
          )}
        </section>

        {/* IPFS key */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium text-[var(--text-primary)]">IPFS pinning key</h3>
          <p className="text-[11.5px] text-[var(--text-secondary)]">
            {keyStatus.data?.stored
              ? 'A key is stored (encrypted).'
              : 'No key stored. Recommended: a Blockfrost IPFS project id.'}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <input
              type="password"
              value={ipfsKey}
              onChange={(e) => setIpfsKey(e.target.value)}
              placeholder="IPFS project id"
              className={`${inputCls} flex-1`}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!ipfsKey.trim() || storeKey.isPending}
              onClick={() =>
                storeKey.mutate(
                  { ipfsProjectId: ipfsKey.trim() },
                  { onSuccess: () => setIpfsKey('') },
                )
              }
            >
              {storeKey.isPending ? 'Saving…' : 'Save key'}
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
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
        <CardHeader>
          <CardTitle>Committee details</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] text-[var(--text-secondary)]">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  if (details.isError || !details.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Committee details</CardTitle>
        </CardHeader>
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
      <CardHeader>
        <CardTitle>Committee details</CardTitle>
      </CardHeader>
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
