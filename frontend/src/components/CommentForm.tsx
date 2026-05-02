import React, { useState } from 'react';
import { useIsAuthenticated } from '@/stores/authStore';
import { useCreateComment } from '@/hooks/useComments';
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
  const isAuthenticated = useIsAuthenticated();
  const createComment = useCreateComment();
  const { addToast } = useUiStore();

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!body.trim()) return;

    try {
      // TODO: In production, request a mutation nonce and wallet re-sign here.
      // For Phase 1 the backend stub accepts empty nonce/sig values in dev mode.
      await createComment.mutateAsync({
        actionId,
        body: body.trim(),
        isPublic,
        mutationNonce: 'dev-nonce',
        mutationSignature: 'dev-sig',
        mutationKey: 'dev-key',
      });
      setBody('');
      addToast({ title: 'Comment posted', variant: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to post comment';
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

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className={cn('space-y-3', className)}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Share your perspective on this governance action…"
        rows={4}
        maxLength={10_000}
        className={cn(
          'w-full rounded-token-md border border-[var(--border-default)]',
          'bg-[var(--bg-canvas)] text-[var(--text-primary)] px-3 py-2 text-sm',
          'focus:outline-none focus:border-[var(--brand-primary)] focus:shadow-token-focus',
          'transition-all duration-150 resize-none',
        )}
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
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
            disabled={createComment.isPending || !body.trim()}
          >
            {createComment.isPending ? 'Posting…' : 'Post Comment'}
          </Button>
        </div>
      </div>
    </form>
  );
}
