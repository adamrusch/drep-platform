import type React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Status pill mapping governance lifecycle states to brand-token colors.
 * Replaces the hand-rolled `bg-green-100 text-green-800` Tailwind classes
 * with the design tokens defined in `design-system.css`.
 */
const STATUS_TO_CLASSES: Record<string, string> = {
  active: 'bg-[var(--success-soft)] text-[var(--success)]',
  enacted: 'bg-[var(--info-soft)] text-[var(--info)]',
  expired: 'bg-[var(--bg-muted)] text-[var(--text-secondary)]',
  dropped: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  // Optional override states the backend can apply to a proposal admin label.
  passed: 'bg-[var(--success-soft)] text-[var(--success)]',
  failed: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  voting: 'bg-[var(--info-soft)] text-[var(--info)]',
  discussion: 'bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]',
  review: 'bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]',
  warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  neutral: 'bg-[var(--bg-muted)] text-[var(--text-secondary)]',
  drep: 'bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]',
  trusted: 'bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]',
};

interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string;
  /** Optional label override. When omitted, the translated `status.<key>`
   *  label is used (falling back to a capitalized `status`). */
  label?: string;
}

export function StatusPill({
  status,
  label,
  className,
  ...props
}: StatusPillProps): React.ReactElement {
  const { t } = useTranslation();
  const key = status.toLowerCase();
  const classes = STATUS_TO_CLASSES[key] ?? STATUS_TO_CLASSES.neutral;
  // Explicit label wins; otherwise translate the known status key, falling back
  // to a capitalized version of the raw status string.
  const fallback = status.charAt(0).toUpperCase() + status.slice(1);
  const display = label ?? t(`status.${key}`, { defaultValue: fallback });
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap',
        'text-[11.5px] font-semibold tracking-tight',
        'px-2 py-0.5 rounded-token-full',
        classes,
        className,
      )}
      {...props}
    >
      {display}
    </span>
  );
}
