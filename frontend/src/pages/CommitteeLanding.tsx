import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  useAuthStore,
  useIsCommitteeMember,
  useIsAuthenticated,
} from '@/stores/authStore';
import { useCheckMembers, useRegisterCommittee } from '@/hooks/useCommitteeMembership';
import { isTestStage } from '@/lib/stage';
import type { CheckMemberResult } from '@/types/committee';

const inputCls =
  'w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-[13px] focus:outline-none focus-visible:shadow-token-focus';

const MIN_COMMITTEE_MEMBERS = 3;
const MAX_COMMITTEE_MEMBERS = 51; // 1 chair + 50 others (backend cap)
const ADDRESS_CHECK_DEBOUNCE_MS = 400;

export function CommitteeLanding(): React.ReactElement {
  const isAuthed = useIsAuthenticated();
  const isMember = useIsCommitteeMember();
  const drepId = useAuthStore((s) => s.drepId);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">DRep Committees</h1>
      <p className="max-w-2xl text-[14px] text-[var(--text-secondary)]">
        Committees let a lead DRep and their members deliberate on each governance action,
        vote with a count-based <strong>X of N</strong> rule, author a shared rationale, and
        submit the vote on-chain.
      </p>

      {isMember && drepId ? (
        <Card>
          <CardHeader>
            <CardTitle>Your committee</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              to={`/committee/${encodeURIComponent(drepId)}`}
              className="text-[var(--brand-primary)] hover:underline"
            >
              Go to your committee's proposals →
            </Link>
          </CardContent>
        </Card>
      ) : isAuthed ? (
        <FormationGate />
      ) : (
        <Card>
          <CardContent>
            <p className="text-[13.5px] text-[var(--text-secondary)]">
              Connect your wallet (top-right) to register a DRep committee or join one.
            </p>
          </CardContent>
        </Card>
      )}

      <CommitteeFAQ />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Formation gate — "are you a registered DRep?" → either the wizard or a link
// to /profile/setup. The drep id is never typed; it's already known from the
// auth-store (set by `useLinkDrep` server-side), so all the Chair has to do is
// click "Establish".
// ----------------------------------------------------------------------------

function FormationGate(): React.ReactElement {
  const drepId = useAuthStore((s) => s.drepId);
  const [wizardOpen, setWizardOpen] = useState(false);

  if (!drepId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>You're not yet a registered DRep</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-[13.5px]">
          <p className="text-[var(--text-secondary)]">
            Only registered DReps can form a committee. Link your wallet to your registered
            DRep on your profile, then come back here to establish a committee.
          </p>
          <Link
            to="/profile/setup"
            className="text-[var(--brand-primary)] hover:underline"
          >
            Link your DRep on your profile →
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (wizardOpen) {
    return <FormationWizard onCancel={() => setWizardOpen(false)} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>You're a registered DRep ✓</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-[13.5px]">
        <p className="text-[var(--text-secondary)]">
          Your wallet is linked to a registered DRep. You can establish a committee to
          deliberate and vote on governance actions with members you choose.
        </p>
        <Button size="sm" variant="primary" onClick={() => setWizardOpen(true)}>
          Yes, establish a committee
        </Button>
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Wizard
// ----------------------------------------------------------------------------

type Step = 'details' | 'members' | 'threshold' | 'confirm' | 'done';

interface MemberRow {
  /** Stable id so React keys survive re-orders. */
  id: string;
  /** Raw address as typed (payment OR stake form). */
  value: string;
  /** Latest check-members result for this row (when value is non-empty). */
  status?: CheckMemberResult;
  /** Set while we're awaiting the check-members call for this row. */
  checking?: boolean;
}

function makeRow(): MemberRow {
  return { id: crypto.randomUUID(), value: '' };
}

function FormationWizard({ onCancel }: { onCancel: () => void }): React.ReactElement {
  const register = useRegisterCommittee();
  const checkMembers = useCheckMembers();
  const chairStake = useAuthStore((s) => s.walletAddress);

  // ---- form state ----
  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberCount, setMemberCount] = useState(MIN_COMMITTEE_MEMBERS);
  const [rows, setRows] = useState<MemberRow[]>(() =>
    Array.from({ length: MIN_COMMITTEE_MEMBERS - 1 }, makeRow),
  );
  const [approvalThreshold, setApprovalThreshold] = useState<number>(
    Math.floor(MIN_COMMITTEE_MEMBERS / 2) + 1,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ drepId: string } | null>(null);

  // ---- keep `rows` length in sync with `memberCount` ----
  // memberCount is the TOTAL (chair + others) so the other-rows count is
  // memberCount - 1.
  useEffect(() => {
    const needRows = Math.max(0, memberCount - 1);
    setRows((cur) => {
      if (cur.length === needRows) return cur;
      if (cur.length < needRows) {
        return [...cur, ...Array.from({ length: needRows - cur.length }, makeRow)];
      }
      return cur.slice(0, needRows);
    });
  }, [memberCount]);

  // ---- approvalThreshold clamped to [1, N] when N changes ----
  useEffect(() => {
    setApprovalThreshold((cur) => {
      if (cur < 1) return 1;
      if (cur > memberCount) return memberCount;
      return cur;
    });
  }, [memberCount]);

  // ---- live address check, debounced per row-set ----
  // We re-run the batched check whenever the set of trimmed, non-empty values
  // changes. Results are stitched back onto each row by `input` match.
  const trimmedValues = rows.map((r) => r.value.trim());
  const checkKey = trimmedValues.join('||');
  const checkRef = useRef<{ key: string; timer?: ReturnType<typeof setTimeout> }>(
    { key: '' },
  );
  useEffect(() => {
    if (checkRef.current.timer) clearTimeout(checkRef.current.timer);
    const inputs = trimmedValues.filter((v) => v.length > 0);
    if (inputs.length === 0) return;
    checkRef.current.timer = setTimeout(() => {
      const targets = [...new Set(inputs)];
      setRows((cur) =>
        cur.map((r) =>
          r.value.trim().length > 0 ? { ...r, checking: true } : { ...r, checking: false },
        ),
      );
      checkMembers.mutate(
        { addresses: targets },
        {
          onSuccess: (resp) => {
            const byInput = new Map<string, CheckMemberResult>();
            for (const r of resp.results) byInput.set(r.input, r);
            setRows((cur) =>
              cur.map((row) => {
                const v = row.value.trim();
                if (v.length === 0) {
                  const next: MemberRow = { ...row, checking: false };
                  delete next.status;
                  return next;
                }
                const status = byInput.get(v);
                return status
                  ? { ...row, status, checking: false }
                  : { ...row, checking: false };
              }),
            );
          },
          onError: () => {
            setRows((cur) => cur.map((r) => ({ ...r, checking: false })));
          },
        },
      );
    }, ADDRESS_CHECK_DEBOUNCE_MS);
    return () => {
      if (checkRef.current.timer) clearTimeout(checkRef.current.timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);

  // ---- derived ----
  const trimmedNonEmpty = trimmedValues.filter((v) => v.length > 0);
  const allFilled = rows.length > 0 && trimmedNonEmpty.length === rows.length;
  const allValid = allFilled && rows.every((r) => r.status?.valid === true);
  const uniqueStakeCount = new Set(
    rows
      .map((r) => r.status?.stakeAddress)
      .filter((s): s is string => Boolean(s)),
  ).size;
  const hasDuplicates =
    rows.filter((r) => r.status?.valid).length > uniqueStakeCount;
  // The Chair is auto-added as member #1; the backend silently drops the
  // chair's own stake if it appears in `members`. Block it at the UI layer so
  // the row count the user picked matches the committee they actually get.
  const chairInRows =
    chairStake !== null &&
    rows.some((r) => r.status?.valid && r.status.stakeAddress === chairStake);

  const detailsValid = name.trim().length > 0 && description.trim().length > 0;
  const membersValid =
    allValid &&
    !hasDuplicates &&
    !chairInRows &&
    rows.length >= MIN_COMMITTEE_MEMBERS - 1;
  const thresholdValid =
    Number.isInteger(approvalThreshold) &&
    approvalThreshold >= 1 &&
    approvalThreshold <= memberCount;

  // ---- submit ----
  const submit = (): void => {
    if (!detailsValid || !membersValid || !thresholdValid) return;
    setSubmitError(null);
    register.mutate(
      {
        committeeName: name.trim(),
        description: description.trim(),
        members: rows.map((r) => r.value.trim()),
        approvalThreshold,
      },
      {
        onSuccess: (c) => {
          setCreated({ drepId: c.drepId });
          setStep('done');
        },
        onError: (err) => {
          setSubmitError(
            (err as Error)?.message ??
              'Could not create the committee. Please double-check the addresses and try again.',
          );
        },
      },
    );
  };

  // ---- created state ----
  if (created) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Committee created ✓</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-[13.5px]">
          <p className="text-[var(--text-secondary)]">
            Your committee is registered. <strong className="text-[var(--text-primary)]">Reconnect your wallet</strong> (top-right)
            to activate your lead-DRep role, then manage members and open proposals.
          </p>
          <Link
            to={`/committee/${encodeURIComponent(created.drepId)}`}
            className="text-[var(--brand-primary)] hover:underline"
          >
            Go to your committee →
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Establish a committee</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <WizardSteps step={step} />

        {step === 'details' && (
          <DetailsStep
            name={name}
            setName={setName}
            description={description}
            setDescription={setDescription}
          />
        )}

        {step === 'members' && (
          <MembersStep
            memberCount={memberCount}
            setMemberCount={setMemberCount}
            rows={rows}
            setRows={setRows}
            chairInRows={chairInRows}
            hasDuplicates={hasDuplicates}
          />
        )}

        {step === 'threshold' && (
          <ThresholdStep
            memberCount={memberCount}
            approvalThreshold={approvalThreshold}
            setApprovalThreshold={setApprovalThreshold}
          />
        )}

        {step === 'confirm' && (
          <ConfirmStep
            name={name.trim()}
            description={description.trim()}
            memberCount={memberCount}
            rows={rows}
            approvalThreshold={approvalThreshold}
            submitError={submitError}
            isPending={register.isPending}
          />
        )}

        <WizardNav
          step={step}
          setStep={setStep}
          onCancel={onCancel}
          onSubmit={submit}
          isPending={register.isPending}
          canAdvance={
            (step === 'details' && detailsValid) ||
            (step === 'members' && membersValid) ||
            (step === 'threshold' && thresholdValid) ||
            (step === 'confirm' && detailsValid && membersValid && thresholdValid)
          }
        />
      </CardContent>
    </Card>
  );
}

function WizardSteps({ step }: { step: Step }): React.ReactElement {
  const order: Step[] = ['details', 'members', 'threshold', 'confirm'];
  const labels: Record<Step, string> = {
    details: '1. Details',
    members: '2. Members',
    threshold: '3. X of N',
    confirm: '4. Confirm',
    done: '✓ Done',
  };
  return (
    <ol className="flex flex-wrap items-center gap-2 text-[12px]">
      {order.map((s, i) => {
        const active = s === step;
        const past = order.indexOf(step) > i;
        return (
          <li
            key={s}
            className={
              active
                ? 'rounded-full bg-[var(--brand-primary)] px-2.5 py-1 text-white font-semibold'
                : past
                  ? 'rounded-full border border-[var(--border-default)] px-2.5 py-1 text-[var(--text-primary)]'
                  : 'rounded-full border border-[var(--border-default)] px-2.5 py-1 text-[var(--text-secondary)]'
            }
          >
            {labels[s]}
          </li>
        );
      })}
    </ol>
  );
}

// ---- Step 1: Details ----

function DetailsStep({
  name,
  setName,
  description,
  setDescription,
}: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <label className="block text-[12px] text-[var(--text-secondary)]">
        Committee name
        <input
          className={`${inputCls} mt-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Cardano Builders Collective"
        />
      </label>
      <label className="block text-[12px] text-[var(--text-secondary)]">
        Description
        <textarea
          className={`${inputCls} mt-1 min-h-[90px] resize-y`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this committee stands for…"
        />
      </label>
    </div>
  );
}

// ---- Step 2: Members ----

function MembersStep({
  memberCount,
  setMemberCount,
  rows,
  setRows,
  chairInRows,
  hasDuplicates,
}: {
  memberCount: number;
  setMemberCount: (n: number) => void;
  rows: MemberRow[];
  setRows: React.Dispatch<React.SetStateAction<MemberRow[]>>;
  chairInRows: boolean;
  hasDuplicates: boolean;
}): React.ReactElement {
  const walletAddress = useAuthStore((s) => s.walletAddress);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[12px] text-[var(--text-secondary)]">
          How many members will the committee have?
          <input
            type="number"
            min={MIN_COMMITTEE_MEMBERS}
            max={MAX_COMMITTEE_MEMBERS}
            value={memberCount}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isNaN(next)) return;
              const clamped = Math.max(
                MIN_COMMITTEE_MEMBERS,
                Math.min(MAX_COMMITTEE_MEMBERS, next),
              );
              setMemberCount(clamped);
            }}
            className={`${inputCls} mt-1 w-28`}
          />
        </label>
        <p className="pb-1 text-[11.5px] text-[var(--text-secondary)]">
          Including you — the Chair. Minimum {MIN_COMMITTEE_MEMBERS}.
        </p>
      </div>

      <ul className="space-y-2">
        <li className="flex items-center gap-3 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] px-3 py-2 text-[12.5px]">
          <span className="font-semibold text-[var(--text-primary)]">#1</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-[var(--text-primary)]">You — Chair</div>
            <div className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
              {walletAddress ?? '—'}
            </div>
          </div>
          <ActiveBadge active={true} valid={true} />
        </li>
        {rows.map((row, idx) => (
          <MemberRowEditor
            key={row.id}
            index={idx + 2}
            row={row}
            onChange={(value) => {
              setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, value } : r)));
            }}
          />
        ))}
      </ul>

      {chairInRows && (
        <p className="rounded-token-md border border-[var(--danger)] bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-[var(--danger)]">
          You typed your own address as a member. You're already member #1 — remove it from
          the list below.
        </p>
      )}
      {hasDuplicates && (
        <p className="rounded-token-md border border-[var(--danger)] bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-[var(--danger)]">
          Two of the addresses you typed resolve to the same wallet. Each member must be
          distinct.
        </p>
      )}

      <p className="rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
        <strong className="text-[var(--text-primary)]">Tip:</strong> a "Not active" address
        just means that wallet hasn't signed into the platform yet. You can still add them —
        invite them to sign in so they can participate.
      </p>
    </div>
  );
}

function MemberRowEditor({
  index,
  row,
  onChange,
}: {
  index: number;
  row: MemberRow;
  onChange: (v: string) => void;
}): React.ReactElement {
  const trimmed = row.value.trim();
  const showStatus = trimmed.length > 0;
  return (
    <li className="space-y-1 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="font-semibold text-[var(--text-primary)]">#{index}</span>
        <input
          className={`${inputCls} flex-1 font-mono`}
          value={row.value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="addr1… or stake1…"
          autoComplete="off"
          spellCheck={false}
        />
        {showStatus && (
          <ActiveBadge
            valid={row.status?.valid}
            active={row.status?.active}
            checking={row.checking && !row.status}
          />
        )}
      </div>
      {row.status?.valid === false && (
        <p className="pl-7 text-[11.5px] text-[var(--danger)]">
          Not a valid Cardano payment or stake address.
        </p>
      )}
      {row.status?.valid && row.status.displayName && (
        <p className="pl-7 text-[11.5px] text-[var(--text-secondary)]">
          {row.status.displayName}
        </p>
      )}
    </li>
  );
}

function ActiveBadge({
  valid,
  active,
  checking,
}: {
  valid?: boolean;
  active?: boolean;
  checking?: boolean;
}): React.ReactElement {
  if (checking) {
    return (
      <span className="shrink-0 text-[11.5px] text-[var(--text-secondary)]">Checking…</span>
    );
  }
  if (valid === false) {
    return (
      <span className="shrink-0 text-[11.5px] text-[var(--danger)]">✗ Invalid</span>
    );
  }
  if (valid && active) {
    return (
      <span className="shrink-0 text-[11.5px] font-medium text-[var(--success)]">
        ✓ Active
      </span>
    );
  }
  if (valid && active === false) {
    return (
      <span className="shrink-0 text-[11.5px] font-medium text-[var(--danger)]">
        ✗ Not active
      </span>
    );
  }
  return <span className="shrink-0 text-[11.5px] text-[var(--text-secondary)]">—</span>;
}

// ---- Step 3: X of N ----

function ThresholdStep({
  memberCount,
  approvalThreshold,
  setApprovalThreshold,
}: {
  memberCount: number;
  approvalThreshold: number;
  setApprovalThreshold: (n: number) => void;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[var(--text-primary)]">
        How many of the <strong>{memberCount}</strong> members must vote
        <strong> Agree</strong> for a governance action to be{' '}
        <strong>Committee Approved</strong>?
      </p>
      <div className="flex items-end gap-3">
        <label className="text-[12px] text-[var(--text-secondary)]">
          X (1–{memberCount})
          <input
            type="number"
            min={1}
            max={memberCount}
            value={approvalThreshold}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isNaN(next)) return;
              setApprovalThreshold(Math.max(1, Math.min(memberCount, next)));
            }}
            className={`${inputCls} mt-1 w-28`}
          />
        </label>
        <p className="pb-2 text-[12.5px] text-[var(--text-primary)]">
          <strong>{approvalThreshold}</strong> of <strong>{memberCount}</strong>
        </p>
      </div>
      <ul className="space-y-1 text-[12px] text-[var(--text-secondary)]">
        <li>
          <strong>Simple majority:</strong> X = {Math.floor(memberCount / 2) + 1} of{' '}
          {memberCount}.
        </li>
        <li>
          <strong>Unanimous:</strong> X = {memberCount} of {memberCount} — everyone must
          agree.
        </li>
        <li>
          Abstentions and disagreements simply aren't Agree votes — they don't lower the bar.
        </li>
        <li>
          Adding or removing a member later will require restating this rule.
        </li>
      </ul>
    </div>
  );
}

// ---- Step 4: Confirm ----

function ConfirmStep({
  name,
  description,
  memberCount,
  rows,
  approvalThreshold,
  submitError,
  isPending,
}: {
  name: string;
  description: string;
  memberCount: number;
  rows: MemberRow[];
  approvalThreshold: number;
  submitError: string | null;
  isPending: boolean;
}): React.ReactElement {
  const walletAddress = useAuthStore((s) => s.walletAddress);
  return (
    <div className="space-y-4 text-[13px]">
      <div>
        <div className="text-[12px] uppercase tracking-wide text-[var(--text-secondary)]">
          Name
        </div>
        <div className="font-medium text-[var(--text-primary)]">{name}</div>
      </div>
      <div>
        <div className="text-[12px] uppercase tracking-wide text-[var(--text-secondary)]">
          Description
        </div>
        <div className="whitespace-pre-wrap text-[var(--text-primary)]">{description}</div>
      </div>
      <div>
        <div className="text-[12px] uppercase tracking-wide text-[var(--text-secondary)]">
          Members ({memberCount})
        </div>
        <ul className="mt-1 space-y-1">
          <li className="flex items-center justify-between gap-2 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] px-3 py-1.5">
            <span>
              <span className="mr-2 font-semibold text-[var(--text-primary)]">#1</span>
              You — Chair
            </span>
            <span className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
              {walletAddress ?? '—'}
            </span>
          </li>
          {rows.map((r, i) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-token-md border border-[var(--border-default)] px-3 py-1.5"
            >
              <span>
                <span className="mr-2 font-semibold text-[var(--text-primary)]">
                  #{i + 2}
                </span>
                {r.status?.displayName ?? (r.status?.active ? 'Active member' : 'Member')}
              </span>
              <span className="flex items-center gap-2">
                <span className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
                  {r.value.trim()}
                </span>
                <ActiveBadge valid={r.status?.valid} active={r.status?.active} />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="text-[12px] uppercase tracking-wide text-[var(--text-secondary)]">
          Approval rule
        </div>
        <div className="text-[var(--text-primary)]">
          <strong>{approvalThreshold}</strong> of <strong>{memberCount}</strong> members must
          vote Agree for Committee Approved.
        </div>
      </div>
      {isTestStage() && (
        <p className="rounded-token-md border border-[var(--border-strong)] bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
          <strong className="text-[var(--text-primary)]">TEST environment</strong> — on-chain
          vote submission is disabled here; votes must be submitted from production.
        </p>
      )}
      {submitError && <p className="text-[12px] text-[var(--danger)]">{submitError}</p>}
      {isPending && (
        <p className="text-[12px] text-[var(--text-secondary)]">Creating committee…</p>
      )}
    </div>
  );
}

// ---- Wizard navigation ----

function WizardNav({
  step,
  setStep,
  onCancel,
  onSubmit,
  isPending,
  canAdvance,
}: {
  step: Step;
  setStep: (s: Step) => void;
  onCancel: () => void;
  onSubmit: () => void;
  isPending: boolean;
  canAdvance: boolean;
}): React.ReactElement {
  const order: Step[] = ['details', 'members', 'threshold', 'confirm'];
  const idx = order.indexOf(step);
  const isLast = step === 'confirm';
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--border-default)] pt-3">
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={isPending}>
        Cancel
      </Button>
      <div className="flex items-center gap-2">
        {idx > 0 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={isPending}
            onClick={() => setStep(order[idx - 1]!)}
          >
            Back
          </Button>
        )}
        {!isLast ? (
          <Button
            size="sm"
            variant="primary"
            disabled={!canAdvance}
            onClick={() => setStep(order[idx + 1]!)}
          >
            Next
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!canAdvance || isPending}
            onClick={onSubmit}
          >
            {isPending ? 'Creating…' : 'Create committee'}
          </Button>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// FAQ
// ----------------------------------------------------------------------------

function CommitteeFAQ(): React.ReactElement {
  const items = useMemo(
    () => [
      {
        q: 'Who can form a committee?',
        a: 'Only a wallet that is already linked to a registered DRep. If you\'re not a registered DRep yet, link your DRep on your profile first — your committee will then bind to your DRep, so all of its on-chain votes are cast as the DRep you control.',
      },
      {
        q: 'Who is member #1?',
        a: 'You are. The Chair (the lead DRep forming the committee) is automatically added as the first member. You then add the rest by Cardano address.',
      },
      {
        q: 'How do I add the other members?',
        a: 'By their Cardano address — either a payment address (addr1…) or a stake address (stake1…). The platform stores everyone by their canonical stake identity, so two different payment addresses for the same wallet resolve to the same person.',
      },
      {
        q: 'What\'s the difference between "Active" and "Not active"?',
        a: '"Active" means that wallet has signed into the platform before, so they can immediately participate. "Not active" just means we haven\'t seen them sign in — you can still add them. Invite them to sign in so they can cast votes and edit rationales.',
      },
      {
        q: 'What does "X of N" mean?',
        a: 'X is how many of your N members must vote Agree for a governance action to be Committee Approved. For example, "3 of 5" means at least 3 of your 5 members have to vote Agree before you can close the proposal as passed. Abstentions and disagreements don\'t lower the bar — only Agree votes count toward X.',
      },
      {
        q: 'Why do I have to restate "X of N" when adding or removing a member?',
        a: 'Because N changes. A "3 of 5" rule isn\'t meaningful if N drops to 4 — you might want 3 of 4, or 2 of 4, or unanimous. Every membership change requires you to consciously restate the rule so the consensus model never silently drifts.',
      },
      {
        q: 'What\'s the minimum committee size?',
        a: 'Three members, including you. A committee with fewer members isn\'t a committee — that\'s a single DRep with extra steps.',
      },
      ...(isTestStage()
        ? [
            {
              q: 'Does anything happen on-chain in this environment?',
              a: 'No. This is the TEST environment — on-chain vote submission is disabled here. Everything else (proposals, voting, rationale, member changes) works exactly as in production, so you can practice the full flow without spending ada.',
            },
          ]
        : []),
    ],
    [],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>How committees work</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {items.map((item) => (
            <li
              key={item.q}
              className="border-b border-[var(--border-default)] last:border-b-0"
            >
              <details className="group">
                <summary className="cursor-pointer list-none py-2.5 text-[13.5px] font-medium text-[var(--text-primary)] hover:text-[var(--brand-primary)]">
                  <span className="mr-2 inline-block w-3 text-[var(--text-secondary)] group-open:rotate-90 transition-transform">
                    ›
                  </span>
                  {item.q}
                </summary>
                <p className="pb-3 pl-5 text-[13px] text-[var(--text-secondary)]">{item.a}</p>
              </details>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
