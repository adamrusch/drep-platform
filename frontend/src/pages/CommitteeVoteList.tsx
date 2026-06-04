import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { useAuthStore } from '@/stores/authStore';
import { useCommitteeVoteList, useOpenProposal } from '@/hooks/useCommitteeVotes';
import { useGovernanceActions } from '@/hooks/useGovernanceActions';
import { CommitteeSettings } from '@/components/committee/CommitteeSettings';
import type { CommitteePosition } from '@/types/committee';

const POSITIONS: CommitteePosition[] = ['Yes', 'No', 'Abstain'];
// '' is the "nothing chosen yet" sentinel — there is intentionally no default
// position, so the lead must make an explicit Yes/No/Abstain choice.
type PositionChoice = CommitteePosition | '';

export function CommitteeVoteList(): React.ReactElement {
  const { t } = useTranslation();
  const { drepId = '' } = useParams<{ drepId: string }>();
  const myDrepId = useAuthStore((s) => s.drepId);
  const isLeadOfThis = Boolean(myDrepId && myDrepId === drepId);

  const { data, isLoading } = useCommitteeVoteList(drepId);
  const open = useOpenProposal(drepId);

  // Open governance actions to propose against — picked from a dropdown so the
  // lead never pastes a raw hash. We exclude actions this committee already
  // has a proposal for (the backend would reject the duplicate anyway).
  const govActions = useGovernanceActions('active');
  const proposedActionIds = useMemo(
    () => new Set((data?.proposals ?? []).map((p) => p.actionId)),
    [data?.proposals],
  );
  const openActions = useMemo(() => {
    const all = govActions.data?.pages.flatMap((p) => p.items) ?? [];
    return all.filter((a) => !proposedActionIds.has(a.actionId));
  }, [govActions.data, proposedActionIds]);

  const [actionId, setActionId] = useState('');
  const [position, setPosition] = useState<PositionChoice>('');

  const submitProposal = (): void => {
    if (!actionId || !position) return;
    open.mutate(
      { actionId, proposedPosition: position },
      { onSuccess: () => { setActionId(''); setPosition(''); } },
    );
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">{t('committeeRoom.list.title')}</h1>

      <Card>
        <CardHeader><CardTitle>{t('committeeRoom.list.proposeTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            {t('committeeRoom.list.proposeHelp')}
          </p>

          {/* Governance action — dropdown of OPEN actions by title. */}
          <label className="block text-[12px] text-[var(--text-secondary)]">
            {t('committeeRoom.list.actionSelectLabel')}
            {govActions.isLoading ? (
              <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
                {t('committeeRoom.list.actionsLoading')}
              </p>
            ) : openActions.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
                {t('committeeRoom.list.actionsEmpty')}
              </p>
            ) : (
              <select
                value={actionId}
                onChange={(e) => setActionId(e.target.value)}
                className="mt-1 w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] focus:outline-none focus-visible:shadow-token-focus"
              >
                <option value="">{t('committeeRoom.list.actionSelectPlaceholder')}</option>
                {openActions.map((a) => (
                  <option key={a.actionId} value={a.actionId}>
                    {a.title?.trim() || t('committeeRoom.list.untitledAction')}
                  </option>
                ))}
              </select>
            )}
          </label>
          {actionId && (
            <p className="break-all font-mono text-[11px] text-[var(--text-secondary)]">{actionId}</p>
          )}
          {govActions.hasNextPage && openActions.length > 0 && (
            <p className="text-[11px] text-[var(--text-secondary)]">
              {t('committeeRoom.list.actionsMoreNote', { count: openActions.length })}
            </p>
          )}

          {/* Position — explicit, no default. */}
          <label className="block text-[12px] text-[var(--text-secondary)]">
            {t('committeeRoom.list.positionLabel')}
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value as PositionChoice)}
              className="mt-1 w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] focus:outline-none focus-visible:shadow-token-focus sm:w-auto"
            >
              <option value="">{t('committeeRoom.list.positionPlaceholder')}</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>{t(`committeeRoom.list.position.${p}`)}</option>
              ))}
            </select>
          </label>

          <Button
            size="sm"
            variant="primary"
            disabled={!actionId || !position || open.isPending}
            onClick={submitProposal}
          >
            {open.isPending ? t('committeeRoom.list.opening') : t('committeeRoom.list.openProposal')}
          </Button>
          {open.isError && (
            <p className="text-[12.5px] text-[var(--danger)]">
              {(open.error as Error)?.message ?? t('committeeRoom.list.openError')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('committeeRoom.list.proposalsTitle')}</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-[var(--text-secondary)]">{t('committeeRoom.list.loading')}</p>
          ) : !data || data.proposals.length === 0 ? (
            <p className="text-[13px] text-[var(--text-secondary)]">{t('committeeRoom.list.empty')}</p>
          ) : (
            <ul className="divide-y divide-[var(--border-default)]">
              {data.proposals.map((p) => (
                <li key={p.actionId} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--text-primary)]">{t(`committeeRoom.list.position.${p.proposedPosition}`)}</span>
                      <StatusPill status={p.status === 'epoch_finalized' ? 'expired' : p.status} />
                    </div>
                    <div className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]">{p.actionId}</div>
                  </div>
                  <Link
                    to={`/committee/${encodeURIComponent(drepId)}/votes/${encodeURIComponent(p.actionId)}`}
                    className="shrink-0 text-[13px] text-[var(--brand-primary)] hover:underline"
                  >
                    {t('committeeRoom.list.openLink')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {isLeadOfThis && <CommitteeSettings drepId={drepId} />}
    </div>
  );
}
