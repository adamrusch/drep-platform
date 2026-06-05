import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  useAuthStore,
  useMyCommittee,
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
  // The joined committee (lead OR member). For a non-lead member this is the
  // ONLY signal that grants them their committee space — they have no drepId
  // of their own (it belongs to the lead).
  const membership = useMyCommittee();
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">
        {t('committee.pageTitle')}
      </h1>
      <p className="max-w-2xl text-[14px] text-[var(--text-secondary)]">
        <Trans i18nKey="committee.pageIntro" components={{ strong: <strong /> }} />
      </p>

      {membership ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('committee.yourCommitteeTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {membership.committeeName && (
              <p className="text-[13.5px] font-medium text-[var(--text-primary)]">
                {membership.committeeName}
              </p>
            )}
            <Link
              to={`/committee/${encodeURIComponent(membership.drepId)}`}
              className="text-[var(--brand-primary)] hover:underline"
            >
              {t('committee.yourCommitteeLink')}
            </Link>
          </CardContent>
        </Card>
      ) : isAuthed ? (
        <FormationGate />
      ) : (
        <Card>
          <CardContent>
            <p className="text-[13.5px] text-[var(--text-secondary)]">
              {t('committee.guestPrompt')}
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
  const { t } = useTranslation();

  if (!drepId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('committee.notDrepTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-[13.5px]">
          <p className="text-[var(--text-secondary)]">{t('committee.notDrepBody')}</p>
          <Link
            to="/profile/setup"
            className="text-[var(--brand-primary)] hover:underline"
          >
            {t('committee.notDrepLink')}
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
        <CardTitle>{t('committee.isDrepTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-[13.5px]">
        <p className="text-[var(--text-secondary)]">{t('committee.isDrepBody')}</p>
        <Button size="sm" variant="primary" onClick={() => setWizardOpen(true)}>
          {t('committee.establishCta')}
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
  const { t } = useTranslation();

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
              t('committee.wizard.submitErrorFallback'),
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
          <CardTitle>{t('committee.created.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-[13.5px]">
          <p className="text-[var(--text-secondary)]">
            {t('committee.created.bodyPrefix')}
            <strong className="text-[var(--text-primary)]">
              {t('committee.created.bodyReconnect')}
            </strong>
            {t('committee.created.bodySuffix')}
          </p>
          <Link
            to={`/committee/${encodeURIComponent(created.drepId)}`}
            className="text-[var(--brand-primary)] hover:underline"
          >
            {t('committee.created.link')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('committee.wizard.cardTitle')}</CardTitle>
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
  const { t } = useTranslation();
  const order: Step[] = ['details', 'members', 'threshold', 'confirm'];
  const labels: Record<Step, string> = {
    details: t('committee.wizard.stepDetails'),
    members: t('committee.wizard.stepMembers'),
    threshold: t('committee.wizard.stepThreshold'),
    confirm: t('committee.wizard.stepConfirm'),
    done: t('committee.wizard.stepDone'),
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
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <label className="block text-[12px] text-[var(--text-secondary)]">
        {t('committee.wizard.nameLabel')}
        <input
          className={`${inputCls} mt-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('committee.wizard.namePlaceholder')}
        />
      </label>
      <label className="block text-[12px] text-[var(--text-secondary)]">
        {t('committee.wizard.descriptionLabel')}
        <textarea
          className={`${inputCls} mt-1 min-h-[90px] resize-y`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('committee.wizard.descriptionPlaceholder')}
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
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[12px] text-[var(--text-secondary)]">
          {t('committee.wizard.membersCountLabel')}
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
          {t('committee.wizard.membersCountHint', { min: MIN_COMMITTEE_MEMBERS })}
        </p>
      </div>

      <ul className="space-y-2">
        <li className="flex items-center gap-3 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] px-3 py-2 text-[12.5px]">
          <span className="font-semibold text-[var(--text-primary)]">#1</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-[var(--text-primary)]">
              {t('committee.wizard.chairLabel')}
            </div>
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
          {t('committee.wizard.errorChairInRows')}
        </p>
      )}
      {hasDuplicates && (
        <p className="rounded-token-md border border-[var(--danger)] bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-[var(--danger)]">
          {t('committee.wizard.errorDuplicates')}
        </p>
      )}

      <p className="rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
        <strong className="text-[var(--text-primary)]">
          {t('committee.wizard.tipLabel')}
        </strong>{' '}
        {t('committee.wizard.tipBody')}
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
  const { t } = useTranslation();
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
          placeholder={t('committee.wizard.memberAddressPlaceholder')}
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
          {t('committee.wizard.invalidAddress')}
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
  const { t } = useTranslation();
  if (checking) {
    return (
      <span className="shrink-0 text-[11.5px] text-[var(--text-secondary)]">
        {t('committee.wizard.badgeChecking')}
      </span>
    );
  }
  if (valid === false) {
    return (
      <span className="shrink-0 text-[11.5px] text-[var(--danger)]">
        {t('committee.wizard.badgeInvalid')}
      </span>
    );
  }
  if (valid && active) {
    return (
      <span className="shrink-0 text-[11.5px] font-medium text-[var(--success)]">
        {t('committee.wizard.badgeActive')}
      </span>
    );
  }
  if (valid && active === false) {
    return (
      <span className="shrink-0 text-[11.5px] font-medium text-[var(--danger)]">
        {t('committee.wizard.badgeNotActive')}
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
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[var(--text-primary)]">
        <Trans
          i18nKey="committee.wizard.thresholdQuestion"
          values={{ count: memberCount }}
          components={{ strong: <strong /> }}
        />
      </p>
      <div className="flex items-end gap-3">
        <label className="text-[12px] text-[var(--text-secondary)]">
          {t('committee.wizard.thresholdLabel', { count: memberCount })}
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
          <Trans
            i18nKey="committee.wizard.thresholdSummary"
            values={{ x: approvalThreshold, n: memberCount }}
            components={{ strong: <strong /> }}
          />
        </p>
      </div>
      <ul className="space-y-1 text-[12px] text-[var(--text-secondary)]">
        <li>
          <strong>{t('committee.wizard.thresholdMajorityLabel')}</strong>{' '}
          {t('committee.wizard.thresholdMajorityBody', {
            x: Math.floor(memberCount / 2) + 1,
            n: memberCount,
          })}
        </li>
        <li>
          <strong>{t('committee.wizard.thresholdUnanimousLabel')}</strong>{' '}
          {t('committee.wizard.thresholdUnanimousBody', { n: memberCount })}
        </li>
        <li>{t('committee.wizard.thresholdNoLowerBar')}</li>
        <li>{t('committee.wizard.thresholdRestate')}</li>
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
  const { t } = useTranslation();
  return (
    <div className="space-y-4 text-[13px]">
      <div>
        <div className="text-[12px] uppercase tracking-wide text-[var(--text-secondary)]">
          {t('committee.wizard.confirmNameLabel')}
        </div>
        <div className="font-medium text-[var(--text-primary)]">{name}</div>
      </div>
      <div>
        <div className="text-[12px] uppercase tracking-wide text-[var(--text-secondary)]">
          {t('committee.wizard.confirmDescriptionLabel')}
        </div>
        <div className="whitespace-pre-wrap text-[var(--text-primary)]">{description}</div>
      </div>
      <div>
        <div className="text-[12px] uppercase tracking-wide text-[var(--text-secondary)]">
          {t('committee.wizard.confirmMembersLabel', { count: memberCount })}
        </div>
        <ul className="mt-1 space-y-1">
          <li className="flex items-center justify-between gap-2 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] px-3 py-1.5">
            <span>
              <span className="mr-2 font-semibold text-[var(--text-primary)]">#1</span>
              {t('committee.wizard.confirmMemberChair')}
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
                {r.status?.displayName ??
                  (r.status?.active
                    ? t('committee.wizard.confirmMemberActive')
                    : t('committee.wizard.confirmMemberFallback'))}
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
          {t('committee.wizard.confirmRuleLabel')}
        </div>
        <div className="text-[var(--text-primary)]">
          <Trans
            i18nKey="committee.wizard.confirmRuleBody"
            values={{ x: approvalThreshold, n: memberCount }}
            components={{ strong: <strong /> }}
          />
        </div>
      </div>
      {isTestStage() && (
        <p className="rounded-token-md border border-[var(--border-strong)] bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
          <strong className="text-[var(--text-primary)]">
            {t('committee.wizard.testEnvLabel')}
          </strong>
          {t('committee.wizard.testEnvBody')}
        </p>
      )}
      {submitError && <p className="text-[12px] text-[var(--danger)]">{submitError}</p>}
      {isPending && (
        <p className="text-[12px] text-[var(--text-secondary)]">
          {t('committee.wizard.creatingNotice')}
        </p>
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
  const { t } = useTranslation();
  const order: Step[] = ['details', 'members', 'threshold', 'confirm'];
  const idx = order.indexOf(step);
  const isLast = step === 'confirm';
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--border-default)] pt-3">
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={isPending}>
        {t('committee.wizard.cancel')}
      </Button>
      <div className="flex items-center gap-2">
        {idx > 0 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={isPending}
            onClick={() => setStep(order[idx - 1]!)}
          >
            {t('committee.wizard.back')}
          </Button>
        )}
        {!isLast ? (
          <Button
            size="sm"
            variant="primary"
            disabled={!canAdvance}
            onClick={() => setStep(order[idx + 1]!)}
          >
            {t('committee.wizard.next')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!canAdvance || isPending}
            onClick={onSubmit}
          >
            {isPending
              ? t('committee.wizard.createButtonPending')
              : t('committee.wizard.createButton')}
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
  const { t } = useTranslation();
  const items = useMemo(
    () => [
      { q: t('committee.faq.q1'), a: t('committee.faq.a1') },
      { q: t('committee.faq.q2'), a: t('committee.faq.a2') },
      { q: t('committee.faq.q3'), a: t('committee.faq.a3') },
      { q: t('committee.faq.q4'), a: t('committee.faq.a4') },
      { q: t('committee.faq.q5'), a: t('committee.faq.a5') },
      { q: t('committee.faq.q6'), a: t('committee.faq.a6') },
      { q: t('committee.faq.q7'), a: t('committee.faq.a7') },
      ...(isTestStage()
        ? [{ q: t('committee.faq.q8'), a: t('committee.faq.a8') }]
        : []),
    ],
    [t],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('committee.faq.title')}</CardTitle>
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
