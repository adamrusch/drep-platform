import React from 'react';
import { cn } from '@/lib/utils';

interface HeroBandProps {
  title: string;
  subtitle?: string;
  /** Right-aligned content (e.g. CTA button, sync pill). */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Hero band — tinted gradient card with a decorative dot pattern.
 * Mirrors `dashboard.jsx:35–60` and `styles.css:1485–1535` (the `.hero`
 * class with `--bg-hero` linear gradient + concentric `HeroDots`).
 *
 * The dot pattern is rendered inline as SVG so it tracks the theme without
 * additional asset bundling. Opacity is reduced in dark mode by the same
 * CSS rule that scopes `--bg-hero`.
 */
export function HeroBand({
  title,
  subtitle,
  actions,
  className,
}: HeroBandProps): React.ReactElement {
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-token-xl p-6 sm:p-8 border border-[var(--border-default)]',
        // The CSS variable resolves to a linear-gradient in both themes.
        'bg-[var(--bg-hero)]',
        className,
      )}
    >
      <HeroDots className="absolute -top-10 -right-10 w-[280px] h-[280px] pointer-events-none opacity-80" />
      <div className="relative flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-[24px] sm:text-[28px] font-bold tracking-tight text-[var(--text-primary)] leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 text-sm text-[var(--text-secondary)] leading-relaxed max-w-2xl">
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </section>
  );
}

/**
 * Decorative concentric-ring dot pattern. Direct port of the design's
 * `HeroDots` component at `primitives.jsx:79–93`.
 */
function HeroDots({ className }: { className?: string }): React.ReactElement {
  const rings = 9;
  const dots: React.ReactElement[] = [];
  for (let ring = 0; ring < rings; ring++) {
    const r = 18 + ring * 14;
    const count = 6 + ring * 3;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const cx = 140 + Math.cos(angle) * r;
      const cy = 140 + Math.sin(angle) * r;
      const size = ring < 3 ? 2.5 : ring < 6 ? 2 : 1.5;
      dots.push(
        <circle
          key={`${ring}-${i}`}
          cx={cx}
          cy={cy}
          r={size}
          fill="var(--brand-primary)"
          opacity={0.14 + (rings - ring) * 0.04}
        />,
      );
    }
  }
  return (
    <svg
      className={className}
      viewBox="0 0 280 280"
      fill="none"
      aria-hidden="true"
    >
      {dots}
    </svg>
  );
}
