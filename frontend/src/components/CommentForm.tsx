import type React from 'react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useIsAuthenticated, useAuthStore } from '@/stores/authStore';
import { useCreateComment } from '@/hooks/useComments';
import { useMutationSign, type SignedMutation } from '@/hooks/useMutationSign';
import { useUiStore } from '@/stores/uiStore';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

interface CommentFormProps {
  actionId: string;
  /** When set, the form posts a REPLY to this top-level commentId. The
   *  layout flips to a tighter inline shape (smaller padding, "Reply"
   *  button label, Cancel link). */
  parentCommentId?: string;
  /** Optional close callback for the reply variant — wired to the
   *  Cancel link and to the "post succeeded" path so the reply form
   *  collapses back. */
  onClose?: () => void;
  className?: string;
}

export function CommentForm({
  actionId,
  parentCommentId,
  onClose,
  className,
}: CommentFormProps): React.ReactElement {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAuthenticated = useIsAuthenticated();
  const walletName = useAuthStore((s) => s.walletName);
  const createComment = useCreateComment();
  const signMutation = useMutationSign();
  const { addToast } = useUiStore();
  const isReply = parentCommentId !== undefined;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!body.trim()) return;

    // Step 1: re-sign the mutation nonce. We split the spinner state from the
    // network mutation state so the user sees "Signing…" while their wallet
    // shows the prompt, then "Posting…" while the request is in flight.
    setSigning(true);
    let signed: SignedMutation;
    try {
      signed = await signMutation();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('comments.signFailedFallback');
      setError(msg);
      addToast({ title: t('comments.signingFailed'), description: msg, variant: 'error' });
      return;
    } finally {
      setSigning(false);
    }

    // Step 2: post the signed comment.
    try {
      await createComment.mutateAsync({
        actionId,
        body: body.trim(),
        isPublic,
        mutationNonce: signed.mutationNonce,
        mutationSignature: signed.mutationSignature,
        mutationKey: signed.mutationKey,
        ...(parentCommentId ? { parentCommentId } : {}),
      });
      setBody('');
      addToast({
        title: isReply ? t('comments.replyPosted') : t('comments.commentPosted'),
        variant: 'success',
      });
      onClose?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('comments.postFailedFallback');
      setError(msg);
      addToast({ title: t('comments.error'), description: msg, variant: 'error' });
    }
  };

  if (!isAuthenticated) {
    // Reply form is never rendered for unauthenticated users (the Reply
    // affordance is gated below) — this fallback only matters for the
    // top-level form.
    return (
      <div
        className={cn(
          'rounded-token-lg border border-[var(--border-default)] bg-[var(--bg-subtle)]',
          'p-4 text-center text-sm text-[var(--text-secondary)]',
          className,
        )}
      >
        {t('comments.connectToComment')}
      </div>
    );
  }

  // If the user reconnected before walletName persistence shipped, they have
  // no walletName in their session. Surface a clear path forward rather than
  // letting them get a confusing signing error every time they post.
  if (!walletName) {
    return (
      <div
        className={cn(
          'rounded-token-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)]',
          'p-4 text-sm text-[var(--text-secondary)]',
          className,
        )}
      >
        <Trans
          i18nKey="comments.reconnectFull"
          components={{ strong: <strong className="font-semibold text-[var(--text-primary)]" /> }}
        />
      </div>
    );
  }

  const isBusy = signing || createComment.isPending;
  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className={cn(
        'space-y-3',
        isReply &&
          // Reply variant: indented + slightly muted background, mirrors the
          // reply container below.
          'rounded-token-md border border-[var(--border-default)] bg-[var(--bg-subtle)] p-3',
        className,
      )}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          isReply
            ? t('comments.replyPlaceholder')
            : t('comments.commentPlaceholder')
        }
        rows={isReply ? 3 : 4}
        maxLength={10_000}
        disabled={isBusy}
        // biome-ignore lint/a11y/noAutofocus: intentional UX — focus the reply textarea when the user opens a reply box
        autoFocus={isReply}
        className={cn(
          'w-full rounded-token-md border border-[var(--border-default)]',
          'bg-[var(--bg-canvas)] text-[var(--text-primary)] px-3 py-2 text-sm',
          'focus:outline-none focus:border-[var(--brand-primary)] focus:shadow-token-focus',
          'transition-all duration-150 resize-none',
          isBusy && 'opacity-60',
        )}
      />
      <div className="flex items-center justify-between flex-wrap gap-2">
        {!isReply && (
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              disabled={isBusy}
              className="rounded accent-[var(--brand-primary)]"
            />
            {t('comments.makePublic')}
          </label>
        )}
        <div className={cn('flex items-center gap-3', isReply && 'ml-auto')}>
          <span className="text-xs text-[var(--text-tertiary)] tabular-nums">
            {t('comments.charCount', { count: body.length })}
          </span>
          {isReply && onClose && (
            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline"
            >
              {t('comments.cancel')}
            </button>
          )}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={isBusy || !body.trim()}
          >
            {signing
              ? t('comments.signing')
              : createComment.isPending
                ? t('comments.posting')
                : isReply
                  ? t('comments.postReply')
                  : t('comments.postComment')}
          </Button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="text-xs text-[var(--danger)] bg-[var(--danger-soft)] rounded-token-sm px-2 py-1.5"
        >
          {error}
        </div>
      )}
      {!isReply && (
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          {t('comments.signatureNote')}
        </p>
      )}
    </form>
  );
}
