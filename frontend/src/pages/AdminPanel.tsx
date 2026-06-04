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
    </div>
  );
}
