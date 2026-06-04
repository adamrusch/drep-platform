import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ThumbsUp, ThumbsDown, MinusCircle, Shield, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useUiStore } from '@/stores/uiStore';
import { useMutationSign } from '@/hooks/useMutationSign';
import { useAuthStore } from '@/stores/authStore';
import { cn, formatWalletAddress } from '@/lib/utils';

type VoteChoice = 'yes' | 'no' | 'abstain';

const OPTIONS: {
  id: VoteChoice;
  labelKey: string;
  descKey: string;
  Icon: typeof ThumbsUp;
  color: string;
}[] = [
  {
    id: 'yes',
    labelKey: 'castVote.optionSupportLabel',
    descKey: 'castVote.optionSupportDesc',
    Icon: ThumbsUp,
    color: 'var(--success)',
  },
  {
    id: 'no',
    labelKey: 'castVote.optionOpposeLabel',
    descKey: 'castVote.optionOpposeDesc',
    Icon: ThumbsDown,
    color: 'var(--danger)',
  },
  {
    id: 'abstain',
    labelKey: 'castVote.optionAbstainLabel',
    descKey: 'castVote.optionAbstainDesc',
    Icon: MinusCircle,
    color: 'var(--text-tertiary)',
  },
];

interface CastVoteModalProps {
  actionTitle: string;
  trigger: React.ReactNode;
}

/**
 * Cast Vote modal — UX scaffold for an on-chain DRep vote.
 *
 * The on-chain submit step is intentionally deferred. Today the modal:
 *   1. Collects choice + rationale
 *   2. Triggers `useMutationSign` (real wallet re-sign)
 *   3. Toasts success with a "vote recorded locally" disclaimer
 *
 * When the chain-submit handler lands, only the success branch needs
 * to change — the wallet plumbing stays.
 *
 * Design ref: `app.jsx:141–173` (Cast Vote modal),
 * `governance.jsx:346–385` for the rail trigger style.
 */
export function CastVoteModal({ actionTitle, trigger }: CastVoteModalProps): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<VoteChoice | null>(null);
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const addToast = useUiStore((s) => s.addToast);
  const sign = useMutationSign();
  const { walletAddress, drepId } = useAuthStore();

  const handleSubmit = async (): Promise<void> => {
    if (!choice) return;
    setSubmitting(true);
    try {
      // Re-sign step: forces a fresh wallet popup. Returned signature is
      // currently unused (we don't post anything on-chain yet), but
      // proves the wallet is live and matches the auth cookie.
      await sign();
      addToast({
        title: t('castVote.recordedTitle'),
        description: t('castVote.recordedDescription'),
        variant: 'success',
      });
      setOpen(false);
      setChoice(null);
      setRationale('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('castVote.signFailedFallback');
      addToast({ title: t('castVote.couldNotSign'), description: msg, variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-[rgba(15,23,42,0.45)] z-[80] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[90]',
            'w-[min(92vw,540px)] max-h-[85vh] overflow-auto',
            'rounded-token-xl bg-[var(--bg-canvas)] border border-[var(--border-default)] shadow-token-lg',
            'p-6 focus:outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <Dialog.Title className="text-[18px] font-bold text-[var(--text-primary)] m-0">
                {t('castVote.title')}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-[var(--text-secondary)] mt-1 truncate max-w-[420px]">
                {actionTitle}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                aria-label={t('castVote.close')}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors -mt-1 -mr-1 p-1"
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            </Dialog.Close>
          </div>

          {/* Voter context */}
          <div className="rounded-token-md bg-[var(--bg-subtle)] border border-[var(--border-subtle)] p-3 text-[12.5px] text-[var(--text-secondary)] mb-4 grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
                {t('castVote.voter')}
              </div>
              <div className="font-mono text-[11px] truncate text-[var(--text-primary)]">
                {drepId ?? (walletAddress ? formatWalletAddress(walletAddress, 6) : '—')}
              </div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
                {t('castVote.votingPower')}
              </div>
              <div className="font-medium text-[var(--text-primary)]">
                {t('castVote.comingSoon')}
              </div>
            </div>
          </div>

          {/* Choice radio */}
          <div className="space-y-2 mb-4">
            {OPTIONS.map((opt) => {
              const Icon = opt.Icon;
              const active = choice === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setChoice(opt.id)}
                  aria-pressed={active}
                  className={cn(
                    'w-full flex items-center gap-3 p-3 rounded-token-md text-left transition-all duration-150',
                    'border',
                    active
                      ? 'border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]'
                      : 'border-[var(--border-default)] bg-[var(--bg-canvas)] hover:border-[var(--border-strong)]',
                  )}
                >
                  <span
                    className="w-9 h-9 rounded-token-md bg-[var(--bg-muted)] flex items-center justify-center flex-shrink-0"
                    style={{ color: opt.color }}
                  >
                    <Icon size={18} strokeWidth={2} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-[var(--text-primary)]">
                      {t(opt.labelKey)}
                    </span>
                    <span className="block text-[12px] text-[var(--text-tertiary)]">
                      {t(opt.descKey)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center flex-shrink-0',
                      active
                        ? 'border-[var(--brand-primary)]'
                        : 'border-[var(--border-strong)]',
                    )}
                  >
                    {active && (
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: 'var(--brand-primary)' }}
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Rationale */}
          <div className="mb-4">
            <label
              htmlFor="vote-rationale"
              className="block text-[12px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5"
            >
              {t('castVote.rationaleLabel')}
            </label>
            <textarea
              id="vote-rationale"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={t('castVote.rationalePlaceholder')}
              className="w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-[13.5px] resize-y focus:outline-none focus-visible:shadow-token-focus"
            />
          </div>

          {/* Reminder */}
          <div className="flex gap-2 items-start text-[12.5px] text-[var(--text-secondary)] bg-[var(--info-soft)] rounded-token-md p-3 mb-5">
            <Shield
              size={16}
              strokeWidth={2}
              className="text-[var(--info)] flex-shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div>
              {t('castVote.reminder')}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                {t('castVote.cancel')}
              </Button>
            </Dialog.Close>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={!choice || submitting}
            >
              <Check size={14} strokeWidth={2.4} />
              {submitting ? t('castVote.signing') : t('castVote.signSubmit')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
