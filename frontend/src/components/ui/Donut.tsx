import type React from 'react';

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutProps {
  segments: DonutSegment[];
  /** Outer width/height of the SVG. Design uses 140 on detail page, 104 in side cards. */
  size?: number;
  /** Stroke width of the ring. Design uses 20 at 140px, 14 at 104px. */
  strokeWidth?: number;
  /** Big number / value label rendered inside the ring (e.g. "28.6M ₳"). */
  centerValue?: string;
  /** Small caption below `centerValue` (e.g. "Total voting power"). */
  centerLabel?: string;
  className?: string;
}

/**
 * SVG ring chart. Mirrors the design `Donut` primitive at `primitives.jsx:193`,
 * but supports labelled segments + a center value/label pair (the design
 * renders these via an absolutely-positioned `.donut__center` overlay; we use
 * SVG `<text>` so the chart is one self-contained element).
 *
 * Empty segments / zero total render an empty muted ring rather than NaN
 * dasharray values.
 */
export function Donut({
  segments,
  size = 140,
  strokeWidth = 20,
  centerValue,
  centerLabel,
  className,
}: DonutProps): React.ReactElement {
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.value), 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;

  // Pre-compute each segment's strokeDasharray + offset (this is the standard
  // SVG-circle technique — see e.g. https://css-tricks.com/svg-circles-pie-chart/).
  let runningOffset = 0;
  const arcs = segments.map((seg, i) => {
    const segValue = Math.max(0, seg.value);
    const len = total > 0 ? (segValue / total) * circumference : 0;
    const dashArray = `${len} ${circumference - len}`;
    const dashOffset = circumference - runningOffset;
    runningOffset += len;
    return (
      <circle
        key={`${seg.label}-${i}`}
        cx={cx}
        cy={cy}
        r={radius}
        stroke={seg.color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={dashArray}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dasharray 0.5s ease' }}
      />
    );
  });

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={
        centerLabel
          ? `${centerValue ? `${centerValue} — ` : ''}${centerLabel}`
          : 'Donut chart'
      }
    >
      {/* Background ring — visible when total = 0 or as a track behind segments. */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        stroke="var(--bg-muted)"
        strokeWidth={strokeWidth}
        fill="none"
      />
      {arcs}
      {centerValue && (
        <text
          x={cx}
          y={centerLabel ? cy - 4 : cy + 5}
          textAnchor="middle"
          fontSize={Math.max(12, Math.round(size * 0.12))}
          fontWeight={700}
          fill="var(--text-primary)"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {centerValue}
        </text>
      )}
      {centerLabel && (
        <text
          x={cx}
          y={cy + Math.max(10, Math.round(size * 0.09))}
          textAnchor="middle"
          fontSize={Math.max(9, Math.round(size * 0.075))}
          fill="var(--text-tertiary)"
          style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}
