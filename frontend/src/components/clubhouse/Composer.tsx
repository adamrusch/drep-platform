import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, HelpCircle, BarChart3, Plus, X, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useUiStore } from '@/stores/uiStore';
import { useCreateClubhousePost } from '@/hooks/useClubhouse';
import { cn } from '@/lib/utils';
import type { ClubhousePostType } from '@/types';

interface ComposerProps {
  drepId: string;
}

const KIND_OPTIONS: { id: ClubhousePostType; labelKey: string; Icon: typeof MessageCircle }[] = [
  { id: 'discussion', labelKey: 'composer.kind.discussion', Icon: MessageCircle },
  { id: 'question', labelKey: 'composer.kind.question', Icon: HelpCircle },
  { id: 'poll', labelKey: 'composer.kind.poll', Icon: BarChart3 },
];

const MAX_BODY = 10_000;
const DEFAULT_POLL_DAYS = 7;

function defaultClosesAt(): string {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_POLL_DAYS);
  // YYYY-MM-DDTHH:mm — what the datetime-local input expects
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Clubhouse composer matching `clubhouse.jsx:178–215`:
 *  - Type chips (Discussion / Question / Poll)
 *  - Textarea body with character counter
 *  - Conditional poll editor when type=Poll
 *  - Submit posts via `useCreateClubhousePost`
 */
export function Composer({ drepId }: ComposerProps): React.ReactElement {
  const { t } = useTranslation();
  const [draftKind, setDraftKind] = useState<ClubhousePostType>('discussion');
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollMultiple, setPollMultiple] = useState(false);
  const [pollClosesAt, setPollClosesAt] = useState(defaultClosesAt);
  const addToast = useUiStore((s) => s.addToast);
  const createPost = useCreateClubhousePost();

  const isPoll = draftKind === 'poll';
  const validOptions = pollOptions.map((o) => o.trim()).filter(Boolean);
  const submittable =
    body.trim().length > 0 &&
    body.length <= MAX_BODY &&
    (!isPoll || validOptions.length >= 2);

  const handleAddOption = (): void => {
    if (pollOptions.length >= 8) return;
    setPollOptions([...pollOptions, '']);
  };
  const handleRemoveOption = (i: number): void => {
    if (pollOptions.length <= 2) return;
    setPollOptions(pollOptions.filter((_, idx) => idx !== i));
  };
  const handleOptionChange = (i: number, val: string): void => {
    setPollOptions(pollOptions.map((o, idx) => (idx === i ? val : o)));
  };

  const handleSubmit = async (): Promise<void> => {
    if (!submittable) return;
    try {
      await createPost.mutateAsync({
        drepId,
        body: body.trim(),
        type: draftKind,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(isPoll
          ? {
              pollOptions: validOptions.map((label) => ({ label })),
              pollMultiple,
              pollClosesAt: new Date(pollClosesAt).toISOString(),
            }
          : {}),
      });
      addToast({ title: t('composer.toast.postedTitle'), variant: 'success' });
      setBody('');
      setTitle('');
      setPollOptions(['', '']);
      setPollMultiple(false);
      setPollClosesAt(defaultClosesAt());
      setDraftKind('discussion');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('composer.toast.failedToPost');
      addToast({ title: t('composer.toast.couldNotPostTitle'), description: msg, variant: 'error' });
    }
  };

  return (
    <div className="rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] p-5 shadow-token-sm space-y-4">
      {/* Type chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {KIND_OPTIONS.map((k) => {
          const Icon = k.Icon;
          const active = draftKind === k.id;
          return (
            <button
              key={k.id}
              type="button"
              onClick={() => setDraftKind(k.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 h-8 rounded-token-md text-[12.5px] font-semibold transition-colors',
                'border',
                active
                  ? 'bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] border-[var(--brand-primary)]/40'
                  : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] border-transparent hover:bg-[var(--bg-muted)]',
              )}
              aria-pressed={active}
            >
              <Icon size={13} strokeWidth={2} />
              {t(k.labelKey)}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] text-[var(--text-tertiary)] inline-flex items-center gap-1">
          <Lock size={11} strokeWidth={2} aria-hidden="true" />
          {t('composer.privateBadge')}
        </span>
      </div>

      {/* Optional title (mostly for polls — keeps the question + body cleanly separated) */}
      {isPoll && (
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('composer.pollQuestionPlaceholder')}
          className="w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 h-10 text-[13.5px] focus:outline-none focus-visible:shadow-token-focus"
          maxLength={300}
        />
      )}

      {/* Body */}
      <div className="relative">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            isPoll
              ? t('composer.bodyPlaceholder.poll')
              : draftKind === 'question'
                ? t('composer.bodyPlaceholder.question')
                : t('composer.bodyPlaceholder.discussion')
          }
          rows={3}
          className="w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-[13.5px] resize-y focus:outline-none focus-visible:shadow-token-focus"
          maxLength={MAX_BODY}
        />
        <div className="text-right text-[11px] text-[var(--text-tertiary)] tabular-nums mt-1">
          {t('composer.charCount', {
            current: body.length.toLocaleString(),
            max: MAX_BODY.toLocaleString(),
          })}
        </div>
      </div>

      {/* Poll editor */}
      {isPoll && (
        <div className="rounded-token-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 space-y-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
            {t('composer.options')}
          </div>
          {pollOptions.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[11px] text-[var(--text-tertiary)] w-4 tabular-nums">
                {i + 1}.
              </span>
              <input
                type="text"
                value={opt}
                onChange={(e) => handleOptionChange(i, e.target.value)}
                placeholder={t('composer.optionPlaceholder', { index: i + 1 })}
                maxLength={200}
                className="flex-1 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 h-9 text-[13px] focus:outline-none focus-visible:shadow-token-focus"
              />
              {pollOptions.length > 2 && (
                <button
                  type="button"
                  onClick={() => handleRemoveOption(i)}
                  aria-label={t('composer.removeOption', { index: i + 1 })}
                  className="w-7 h-7 rounded-token-md text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[var(--danger-soft)] inline-flex items-center justify-center transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          {pollOptions.length < 8 && (
            <button
              type="button"
              onClick={handleAddOption}
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--brand-primary)] hover:underline"
            >
              <Plus size={12} strokeWidth={2.4} />
              {t('composer.addOption')}
            </button>
          )}
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--border-subtle)]">
            <label className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={pollMultiple}
                onChange={(e) => setPollMultiple(e.target.checked)}
                className="rounded-sm"
              />
              {t('composer.allowMultiple')}
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
              {t('composer.closes')}
              <input
                type="datetime-local"
                value={pollClosesAt}
                onChange={(e) => setPollClosesAt(e.target.value)}
                className="rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2 h-7 text-[12px] focus:outline-none focus-visible:shadow-token-focus"
              />
            </label>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={!submittable || createPost.isPending}
        >
          {createPost.isPending
            ? t('composer.posting')
            : isPoll
              ? t('composer.postPoll')
              : t('composer.post')}
        </Button>
      </div>
    </div>
  );
}
