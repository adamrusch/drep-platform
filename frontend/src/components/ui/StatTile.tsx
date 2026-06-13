import type React from 'react';
import { ArrowUp, ArrowDown, Minus, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatTileTrend {
  direction: 'up' | 'down' | 'flat';
  delta: string;
}

interface StatTileProps {
  label: string;
  value: string | number;
  trend?: StatTileTrend;
  icon?: LucideIcon;
  /** Tint variant for the icon swatch — matches design `.stat__icon--*`. */
  iconVariant?: 'indigo' | 'violet' | 'cyan' | 'amber';
  className?: string;
}

const ICON_VARIANT_CLASSES: Record<NonNullable<StatTileProps['iconVariant']>, string> = {
  // .stat__icon--indigo  brand-primary-soft / brand-primary
  indigo: 'bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]',
  // .stat__icon--violet  brand-accent-soft / brand-accent
  violet: 'bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]',
  // .stat__icon--cyan    rgba(14,165,233,0.1) / brand-cyan
  cyan: 'bg-[rgba(14,165,233,0.1)] text-[var(--brand-cyan)]',
  // .stat__icon--amber   rgba(245,158,11,0.12) / warning
  amber: 'bg-[rgba(245,158,11,0.12)] text-[var(--warning)]',
};

const TREND_CLASSES: Record<StatTileTrend['direction'], string> = {
  up: 'text-[var(--success)]',
  down: 'text-[var(--danger)]',
  flat: 'text-[var(--text-muted)]',
};

/**
 * Single tile for the dashboard stat grid. Mirrors the design `.stat` block
 * at `dashboard.jsx:42–66` and `styles.css:577–630`.
 *
 * The grid that hosts these is `repeat(auto-fit, minmax(180px, 1fr))` (see
 * styles.css:577) — caller composes that wrapper. We keep the tile dumb /
 * presentational so it composes equally well in 2-up, 3-up and 4-up grids.
 */
export function StatTile({
  label,
  value,
  trend,
  icon: Icon,
  iconVariant = 'indigo',
  className,
}: StatTileProps): React.ReactElement {
  const TrendIcon =
    trend?.direction === 'up' ? ArrowUp : trend?.direction === 'down' ? ArrowDown : Minus;
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 p-5',
        'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
        'rounded-token-xl shadow-token-sm',
        className,
      )}
    >
      {Icon && (
        <span
          className={cn(
            'inline-flex items-center justify-center w-9 h-9 rounded-token-md mb-1',
            ICON_VARIANT_CLASSES[iconVariant],
          )}
          aria-hidden="true"
        >
          <Icon size={20} strokeWidth={1.75} />
        </span>
      )}
      <span className="text-[24px] font-bold text-[var(--text-primary)] tabular-nums leading-none">
        {value}
      </span>
      <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      {trend && (
        <span
          className={cn(
            'inline-flex items-center gap-1 text-[11.5px] font-medium tabular-nums',
            TREND_CLASSES[trend.direction],
          )}
        >
          <TrendIcon size={11} strokeWidth={2} aria-hidden="true" />
          {trend.delta}
        </span>
      )}
    </div>
  );
}
