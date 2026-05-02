import React, { useState } from 'react';
import { useIsAuthenticated, useAuthStore } from '@/stores/authStore';
import { useCreateComment } from '@/hooks/useComments';
import { useMutationSign } from '@/hooks/useMutationSign';
import { useUiStore } from '@/stores/uiStore';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

interface CommentFormProps {
  actionId: string;
  className?: string;
}

export function CommentForm({ actionId, className }: CommentFormProps): React.ReactElement {
  const [body, setBody] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAuthenticated = useIsAuthenticated();
  const walletName = useAuthStore((s) => s.walletName);
  const createComment = useCreateComment();
  const signMutation = useMutationSign();
  const { addToast } = useUiStore();

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!body.trim()) return;

    // Step 1: re-sign the mutation nonce. We split the spinner state from the
    // network mutation state so the user sees "Signing…" while their wallet
    // shows the prompt, then "Posting…" while the request is in flight.
    setSigning(true);
    let signed;
    try {
      signed = await signMutation();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to sign comment';
      setError(msg);
      addToast({ title: 'Signing failed', description: msg, variant: 'error' });
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
      });
      setBody('');
      addToast({ title: 'Comment posted', variant: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to post comment';
      setError(msg);
      addToast({ title: 'Error', description: msg, variant: 'error' });
    }
  };

  if (!isAuthenticated) {
    return (
      <div
        className={cn(
          'rounded-token-lg border border-[var(--border-default)] bg-[var(--bg-subtle)]',
          'p-4 text-center text-sm text-[var(--text-secondary)]',
          className,
        )}
      >
        Connect your wallet to leave a comment.
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
        <strong className="font-semibold text-[var(--text-primary)]">Re-connect required.</strong>{' '}
        Posting comments now requires a fresh wallet signature. Please disconnect
        your wallet from the top bar, reconnect it, then come back here.
      </div>
    );
  }

  const isBusy = signing || createComment.isPending;
  return (
    <form onSubmit={(e) => void handleSubmit(e)} className={cn('space-y-3', className)}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Share your perspective on this governance action…"
        rows={4}
        maxLength={10_000}
        disabled={isBusy}
        className={cn(
          'w-full rounded-token-md border border-[var(--border-default)]',
          'bg-[var(--bg-canvas)] text-[var(--text-primary)] px-3 py-2 text-sm',
          'focus:outline-none focus:border-[var(--brand-primary)] focus:shadow-token-focus',
          'transition-all duration-150 resize-none',
          isBusy && 'opacity-60',
        )}
      />
      <div className="flex items-center justify-between flex-wrap gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            disabled={isBusy}
            className="rounded accent-[var(--brand-primary)]"
          />
          Make comment public
        </label>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--text-tertiary)] tabular-nums">
            {body.length}/10,000
          </span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={isBusy || !body.trim()}
          >
            {signing ? 'Signing…' : createComment.isPending ? 'Posting…' : 'Post Comment'}
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
      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        Posting requires a fresh wallet signature. Your wallet will prompt you
        to sign a one-time message — this does not cost any fees and does not
        broadcast a transaction.
      </p>
    </form>
  );
}
