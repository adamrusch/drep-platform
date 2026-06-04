/**
 * Dashboard card surfacing every PENDING committee invitation for the
 * authenticated wallet. Rendered on both DelegatorDashboard and
 * DRepDashboard (any wallet may be invited to a committee).
 *
 * Each row shows the committee name and offers Accept / Reject buttons.
 * Reject is wrapped in a confirm step — declining is non-reversible (the
 * Chair would have to re-invite, which the platform doesn't yet support).
 *
 * Hidden when there are zero pending invitations. The bell badge in the
 * topbar (Layout.tsx) shows the count when > 0.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  usePendingInvitations,
  useRespondInvitation,
} from '@/hooks/useCommitteeInvitations';
import { useUiStore } from '@/stores/uiStore';
import { formatWalletAddress } from '@/lib/utils';

export function InvitationsCard(): React.ReactElement | null {
  const { t } = useTranslation();
  const invitations = usePendingInvitations();

  if (invitations.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Mail size={16} strokeWidth={1.75} aria-hidden="true" />
          {t('invitations.cardTitle', { count: invitations.length })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          {t('invitations.explainer')}
        </p>
        <ul className="space-y-2">
          {invitations.map((invite) => (
            <InvitationRow key={invite.drepId} invite={invite} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface InvitationRowProps {
  invite: {
    drepId: string;
    committeeName: string;
    role: 'committee_member' | 'trusted_delegator';
    invitedAt: string;
  };
}

function InvitationRow({ invite }: InvitationRowProps): React.ReactElement {
  const { t } = useTranslation();
  const respond = useRespondInvitation(invite.drepId);
  const addToast = useUiStore((s) => s.addToast);
  const [confirmingReject, setConfirmingReject] = useState(false);

  const submit = (decision: 'accept' | 'reject'): void => {
    respond.mutate(
      { decision },
      {
        onSuccess: () => {
          addToast({
            title:
              decision === 'accept'
                ? t('invitations.acceptedToast')
                : t('invitations.rejectedToast'),
            variant: 'success',
          });
          setConfirmingReject(false);
        },
        onError: (err) => {
          addToast({
            title:
              decision === 'accept'
                ? t('invitations.acceptFailedToast')
                : t('invitations.rejectFailedToast'),
            description: (err as Error)?.message,
            variant: 'error',
          });
        },
      },
    );
  };

  // Committee name falls back to a short drepId if the backend couldn't
  // resolve the name (committee row missing — should not happen).
  const label =
    invite.committeeName?.trim() || formatWalletAddress(invite.drepId, 8);

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-token-md border border-[var(--border-default)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{label}</div>
        <div className="text-[11.5px] text-[var(--text-secondary)]">
          {t('invitations.roleLine', {
            role:
              invite.role === 'trusted_delegator'
                ? t('invitations.roleTrustedDelegator')
                : t('invitations.roleCommitteeMember'),
          })}
        </div>
      </div>
      {confirmingReject ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--text-secondary)]">
            {t('invitations.rejectConfirm')}
          </span>
          <Button
            size="xs"
            variant="destructive"
            disabled={respond.isPending}
            onClick={() => submit('reject')}
          >
            {respond.isPending ? t('invitations.signing') : t('invitations.rejectConfirmYes')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={respond.isPending}
            onClick={() => setConfirmingReject(false)}
          >
            {t('invitations.rejectConfirmCancel')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="primary"
            disabled={respond.isPending}
            onClick={() => submit('accept')}
          >
            {respond.isPending ? t('invitations.signing') : t('invitations.accept')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={respond.isPending}
            onClick={() => setConfirmingReject(true)}
          >
            {t('invitations.reject')}
          </Button>
        </div>
      )}
    </li>
  );
}
