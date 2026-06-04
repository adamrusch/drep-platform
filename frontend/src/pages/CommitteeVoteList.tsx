import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { useAuthStore } from '@/stores/authStore';
import { useCommitteeVoteList, useOpenProposal } from '@/hooks/useCommitteeVotes';
import { CommitteeSettings } from '@/components/committee/CommitteeSettings';
import type { CommitteePosition } from '@/types/committee';

const POSITIONS: CommitteePosition[] = ['Yes', 'No', 'Abstain'];

export function CommitteeVoteList(): React.ReactElement {
  const { t } = useTranslation();
  const { drepId = '' } = useParams<{ drepId: string }>();
  const myDrepId = useAuthStore((s) => s.drepId);
  const isLeadOfThis = Boolean(myDrepId && myDrepId === drepId);

  const { data, isLoading } = useCommitteeVoteList(drepId);
  const open = useOpenProposal(drepId);
  const [actionId, setActionId] = useState('');
  const [position, setPosition] = useState<CommitteePosition>('Yes');

  const submitProposal = (): void => {
    if (!actionId.trim()) return;
    open.mutate(
      { actionId: actionId.trim(), proposedPosition: position },
      { onSuccess: () => setActionId('') },
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
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={actionId}
              onChange={(e) => setActionId(e.target.value)}
              placeholder={t('committeeRoom.list.actionIdPlaceholder')}
              className="min-w-[280px] flex-1 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] font-mono focus:outline-none focus-visible:shadow-token-focus"
            />
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value as CommitteePosition)}
              className="rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px]"
            >
              {POSITIONS.map((p) => <option key={p} value={p}>{t(`committeeRoom.list.position.${p}`)}</option>)}
            </select>
            <Button size="sm" variant="primary" disabled={!actionId.trim() || open.isPending} onClick={submitProposal}>
              {open.isPending ? t('committeeRoom.list.signing') : t('committeeRoom.list.openProposal')}
            </Button>
          </div>
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
