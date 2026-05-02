import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Card primitive matching the design system `.card` spec:
 * - `bg-[var(--bg-canvas)]`
 * - `border 1px solid var(--border-default)` (light gray, NOT harsh near-black)
 * - `border-radius: var(--r-xl)` (16px)
 * - subtle shadow on hover (sm -> md)
 */
type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  /** When true (default for action / clickable rows), elevates on hover. */
  interactive?: boolean;
  /** Pad-lg variant uses `--s-6` (24px) instead of `--s-5` (20px). */
  padLg?: boolean;
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive = false, padLg = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
        'rounded-token-xl',
        padLg ? 'p-6' : 'p-5',
        'shadow-token-sm',
        interactive &&
          'transition-all duration-150 hover:border-[var(--border-strong)] hover:shadow-token-md',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center justify-between gap-3 mb-4', className)}
      {...props}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      'text-[15px] font-semibold text-[var(--text-primary)] m-0',
      'flex items-center gap-2',
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm text-[var(--text-secondary)]', className)} {...props} />
));
CardContent.displayName = 'CardContent';
