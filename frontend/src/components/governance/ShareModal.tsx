import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, Twitter, MessageCircle, Globe, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';

interface ShareModalProps {
  /** Full URL of the proposal page (https://drep.tools/governance/...). */
  url: string;
  /** Title shown in the share intent body. */
  title: string;
  trigger: React.ReactNode;
}

/**
 * Share modal for governance proposals.
 *
 * Three actions:
 *   - Copy link (clipboard API + toast)
 *   - Tweet/X intent URL
 *   - Discord copy-with-context (clipboard with title + URL formatted
 *     so the paste in a Discord channel reads cleanly)
 *
 * Reference: design `app.jsx:121–139`.
 */
export function ShareModal({ url, title, trigger }: ShareModalProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const addToast = useUiStore((s) => s.addToast);

  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    `${title} — ${url}`,
  )}`;
  const discordPayload = `**${title}**\n${url}`;

  const handleCopyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      addToast({ title: 'Link copied', variant: 'success' });
      setOpen(false);
    } catch {
      addToast({
        title: 'Could not copy',
        description: 'Your browser blocked clipboard access.',
        variant: 'error',
      });
    }
  };
  const handleCopyDiscord = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(discordPayload);
      addToast({
        title: 'Discord snippet copied',
        description: 'Paste it into a Discord channel.',
        variant: 'success',
      });
      setOpen(false);
    } catch {
      addToast({ title: 'Could not copy', variant: 'error' });
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
            'w-[min(92vw,480px)] rounded-token-xl bg-[var(--bg-canvas)]',
            'border border-[var(--border-default)] shadow-token-lg p-6 focus:outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <Dialog.Title className="text-[18px] font-bold text-[var(--text-primary)]">
              Share proposal
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="Close"
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors -mt-1 -mr-1 p-1"
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="text-sm text-[var(--text-secondary)] mb-4">
            Anyone with this link can view the proposal page and public comments.
          </Dialog.Description>

          {/* URL preview */}
          <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--bg-subtle)] rounded-token-md border border-[var(--border-default)] mb-4">
            <Globe
              size={14}
              strokeWidth={2}
              className="text-[var(--text-tertiary)] flex-shrink-0"
              aria-hidden="true"
            />
            <code className="flex-1 font-mono text-[11.5px] text-[var(--text-secondary)] overflow-hidden text-ellipsis whitespace-nowrap">
              {url}
            </code>
          </div>

          {/* Action buttons */}
          <div className="grid grid-cols-3 gap-2 mb-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCopyLink()}
              className="!justify-center"
            >
              <Copy size={14} strokeWidth={2} />
              Copy link
            </Button>
            <Button asChild variant="secondary" size="sm" className="!justify-center">
              <a href={tweetUrl} target="_blank" rel="noopener noreferrer">
                <Twitter size={14} strokeWidth={2} />
                Tweet
              </a>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCopyDiscord()}
              className="!justify-center"
            >
              <MessageCircle size={14} strokeWidth={2} />
              Discord
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-tertiary)] mt-2">
            Discord: copies a formatted snippet you can paste into any channel.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
