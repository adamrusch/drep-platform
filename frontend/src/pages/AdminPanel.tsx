import { useState } from 'react';
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
  const safety = useSafetyMode();
  const clear = useClearSafetyMode();
  const grant = useGrantPlatformAdmin();
  const revoke = useRevokePlatformAdmin();
  const [wallet, setWallet] = useState('');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">Platform admin</h1>

      <Card>
        <CardHeader><CardTitle>Sybil safety mode</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusPill status={safety.data?.active ? 'voting' : 'active'} label={safety.data?.active ? 'Active' : 'Off'} />
            {safety.data?.triggeredByCount != null && (
              <span className="text-[12px] text-[var(--text-secondary)]">
                tripped by {safety.data.triggeredByCount} committees in 12h
              </span>
            )}
          </div>
          <p className="text-[12px] text-[var(--text-secondary)]">
            While active, wallets newer than 7 days can't create a committee. Auto-clears after 72h.
          </p>
          <Button size="sm" variant="secondary" disabled={!safety.data?.active || clear.isPending} onClick={() => clear.mutate()}>
            {clear.isPending ? 'Clearing…' : 'Clear safety mode now'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Platform admins</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="wallet address" className={inputCls} />
            <Button size="sm" variant="primary" disabled={!wallet.trim() || grant.isPending} onClick={() => grant.mutate(wallet.trim(), { onSuccess: () => setWallet('') })}>
              {grant.isPending ? '…' : 'Grant'}
            </Button>
            <Button size="sm" variant="destructive" disabled={!wallet.trim() || revoke.isPending} onClick={() => revoke.mutate(wallet.trim(), { onSuccess: () => setWallet('') })}>
              {revoke.isPending ? '…' : 'Revoke'}
            </Button>
          </div>
          {(grant.isError || revoke.isError) && (
            <p className="text-[12px] text-[var(--danger)]">
              {((grant.error || revoke.error) as Error)?.message ?? 'Action failed.'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
