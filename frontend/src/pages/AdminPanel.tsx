import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import {
  useSafetyMode,
  useClearSafetyMode,
  useGrantPlatformAdmin,
  useRevokePlatformAdmin,
  useFlaggedQueue,
  useFlaggers,
  useSetHidden,
  type ModerationContentType,
  type ModerationQueueItem,
} from '@/hooks/useAdmin';

const inputCls =
  'flex-1 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] font-mono focus:outline-none focus-visible:shadow-token-focus';

/** Platform operator panel — gated to platform_admin via RoleGuard at the route. */
export function AdminPanel(): React.ReactElement {
  const { t } = useTranslation();
  const safety = useSafetyMode();
  const clear = useClearSafetyMode();
  const grant = useGrantPlatformAdmin();
  const revoke = useRevokePlatformAdmin();
  const [wallet, setWallet] = useState('');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">{t('admin.title')}</h1>

      <Card>
        <CardHeader><CardTitle>{t('admin.safetyMode.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusPill status={safety.data?.active ? 'voting' : 'active'} label={safety.data?.active ? t('admin.safetyMode.active') : t('admin.safetyMode.off')} />
            {safety.data?.triggeredByCount != null && (
              <span className="text-[12px] text-[var(--text-secondary)]">
                {t('admin.safetyMode.trippedBy', { count: safety.data.triggeredByCount })}
              </span>
            )}
          </div>
          <p className="text-[12px] text-[var(--text-secondary)]">
            {t('admin.safetyMode.description')}
          </p>
          <Button size="sm" variant="secondary" disabled={!safety.data?.active || clear.isPending} onClick={() => clear.mutate()}>
            {clear.isPending ? t('admin.safetyMode.clearing') : t('admin.safetyMode.clearNow')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('admin.admins.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder={t('admin.admins.walletPlaceholder')} className={inputCls} />
            <Button size="sm" variant="primary" disabled={!wallet.trim() || grant.isPending} onClick={() => grant.mutate(wallet.trim(), { onSuccess: () => setWallet('') })}>
              {grant.isPending ? t('admin.admins.granting') : t('admin.admins.grant')}
            </Button>
            <Button size="sm" variant="destructive" disabled={!wallet.trim() || revoke.isPending} onClick={() => revoke.mutate(wallet.trim(), { onSuccess: () => setWallet('') })}>
              {revoke.isPending ? t('admin.admins.revoking') : t('admin.admins.revoke')}
            </Button>
          </div>
          {(grant.isError || revoke.isError) && (
            <p className="text-[12px] text-[var(--danger)]">
              {((grant.error || revoke.error) as Error)?.message ?? t('admin.admins.actionFailed')}
            </p>
          )}
        </CardContent>
      </Card>

      <ModerationSection />
    </div>
  );
}

// ---- Moderation section ----

type FilterValue = 'all' | ModerationContentType;

/** Moderation queue + per-row controls. Renders into the AdminPanel as
 *  its own Card. Mutations are wired through `useSetHidden`, which
 *  invalidates the `['admin', 'moderation']` query namespace on success
 *  so the queue re-reads automatically. */
function ModerationSection(): React.ReactElement {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<FilterValue>('all');
  const queue = useFlaggedQueue({
    type: filter === 'all' ? undefined : filter,
  });
  const setHidden = useSetHidden();

  const filterButtons: Array<{ value: FilterValue; label: string }> = [
    { value: 'all', label: t('admin.moderation.filter.all') },
    { value: 'comment', label: t('admin.moderation.filter.comment') },
    { value: 'clubhouse_post', label: t('admin.moderation.filter.clubhousePost') },
    { value: 'clubhouse_comment', label: t('admin.moderation.filter.clubhouseComment') },
  ];

  return (
    <Card data-testid="moderation-section">
      <CardHeader>
        <CardTitle>{t('admin.moderation.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[12px] text-[var(--text-secondary)]">
          {t('admin.moderation.description')}
        </p>

        <div className="flex flex-wrap items-center gap-2" role="tablist">
          {filterButtons.map((b) => (
            <Button
              key={b.value}
              size="sm"
              variant={filter === b.value ? 'primary' : 'secondary'}
              onClick={() => setFilter(b.value)}
              data-testid={`moderation-filter-${b.value}`}
              aria-pressed={filter === b.value}
            >
              {b.label}
            </Button>
          ))}
        </div>

        {queue.isLoading && (
          <p className="text-[12px] text-[var(--text-secondary)]">
            {t('admin.moderation.loading')}
          </p>
        )}
        {queue.isError && (
          <p className="text-[12px] text-[var(--danger)]" data-testid="moderation-error">
            {(queue.error as Error)?.message ?? t('admin.moderation.loadFailed')}
          </p>
        )}
        {queue.data && queue.data.count === 0 && (
          <p
            className="text-[12px] text-[var(--text-secondary)]"
            data-testid="moderation-empty"
          >
            {t('admin.moderation.empty')}
          </p>
        )}

        {queue.data && queue.data.count > 0 && (
          <ul className="space-y-2" data-testid="moderation-queue">
            {queue.data.items.map((item) => (
              <ModerationRow
                key={`${item.type}-${item.id}`}
                item={item}
                onToggleHidden={(next) =>
                  setHidden.mutate({
                    type: item.type,
                    hidden: next,
                    expected: item.hidden,
                    ...item.parent,
                  })
                }
                mutationPending={setHidden.isPending}
              />
            ))}
          </ul>
        )}

        {setHidden.isError && (
          <p
            className="text-[12px] text-[var(--danger)]"
            data-testid="moderation-mutation-error"
          >
            {(setHidden.error as Error)?.message ??
              t('admin.moderation.actionFailed')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface ModerationRowProps {
  item: ModerationQueueItem;
  onToggleHidden: (next: boolean) => void;
  mutationPending: boolean;
}

function ModerationRow({
  item,
  onToggleHidden,
  mutationPending,
}: ModerationRowProps): React.ReactElement {
  const { t } = useTranslation();
  const [showFlaggers, setShowFlaggers] = useState(false);
  const flaggers = useFlaggers(
    showFlaggers
      ? {
          type: item.type,
          ...item.parent,
        }
      : null,
    showFlaggers,
  );

  const typeLabel = t(`admin.moderation.types.${item.type}`);

  return (
    <li
      className="rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] p-3"
      data-testid={`moderation-item-${item.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <StatusPill
          status={item.hidden ? 'voting' : 'active'}
          label={
            item.hidden
              ? t('admin.moderation.row.hiddenPill')
              : t('admin.moderation.row.visiblePill')
          }
        />
        <span className="font-medium text-[var(--text-primary)]">{typeLabel}</span>
        <span className="text-[var(--text-secondary)]">
          {t('admin.moderation.row.flagCount', { count: item.flagCount })}
        </span>
        <span className="font-mono text-[var(--text-secondary)]">{item.id}</span>
      </div>
      <p className="mt-2 text-[12.5px] text-[var(--text-primary)] whitespace-pre-wrap break-words">
        {item.snippet}
      </p>
      <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
        {t('admin.moderation.row.author')}{' '}
        <span className="font-mono">{item.authorWallet}</span>
        {item.authorDisplayName ? ` (${item.authorDisplayName})` : ''}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {item.hidden ? (
          <Button
            size="sm"
            variant="primary"
            disabled={mutationPending}
            onClick={() => onToggleHidden(false)}
            data-testid={`moderation-unhide-${item.id}`}
          >
            {t('admin.moderation.row.unhide')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            disabled={mutationPending}
            onClick={() => onToggleHidden(true)}
            data-testid={`moderation-hide-${item.id}`}
          >
            {t('admin.moderation.row.hide')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setShowFlaggers((v) => !v)}
          data-testid={`moderation-flaggers-toggle-${item.id}`}
          aria-expanded={showFlaggers}
        >
          {showFlaggers
            ? t('admin.moderation.row.hideFlaggers')
            : t('admin.moderation.row.showFlaggers')}
        </Button>
      </div>

      {showFlaggers && (
        <div className="mt-2 border-t border-[var(--border-default)] pt-2">
          {flaggers.isLoading && (
            <p className="text-[11px] text-[var(--text-secondary)]">
              {t('admin.moderation.flaggers.loading')}
            </p>
          )}
          {flaggers.isError && (
            <p className="text-[11px] text-[var(--danger)]">
              {(flaggers.error as Error)?.message ??
                t('admin.moderation.flaggers.loadFailed')}
            </p>
          )}
          {flaggers.data && flaggers.data.count === 0 && (
            <p className="text-[11px] text-[var(--text-secondary)]">
              {t('admin.moderation.flaggers.none')}
            </p>
          )}
          {flaggers.data && flaggers.data.count > 0 && (
            <ul
              className="space-y-1"
              data-testid={`moderation-flaggers-${item.id}`}
            >
              {flaggers.data.flaggers.map((f) => (
                <li
                  key={f.flaggerId}
                  className="text-[11px] text-[var(--text-secondary)]"
                >
                  <span className="font-mono">{f.flaggerId}</span>
                  {' — '}
                  <span>{f.role}</span>
                  {' — '}
                  <span>{f.createdAt}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
