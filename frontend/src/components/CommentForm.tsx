import React, { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useCreateComment } from '@/hooks/useComments';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';

interface CommentFormProps {
  actionId: string;
  className?: string;
}

export function CommentForm({ actionId, className }: CommentFormProps): React.ReactElement {
  const [body, setBody] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const { isAuthenticated } = useAuthStore();
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
      <div className={cn('rounded-md border border-border bg-muted/30 p-4 text-center text-sm text-muted-foreground', className)}>
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
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="rounded"
          />
          Make comment public
        </label>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{body.length}/10,000</span>
          <button
            type="submit"
            disabled={createComment.isPending || !body.trim()}
            className="rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {createComment.isPending ? 'Posting…' : 'Post Comment'}
          </button>
        </div>
      </div>
    </form>
  );
}
