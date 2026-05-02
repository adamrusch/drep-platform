import React from 'react';

interface SparklineProps {
  /** Series of values, oldest → newest. Min 2 points. */
  points: number[];
  /** Stroke + fill gradient color (default brand-primary). */
  color?: string;
  /** SVG viewbox dimensions — keep aspect ratio fixed for crisp rendering. */
  width?: number;
  height?: number;
  /** Render gradient fill area below the line. */
  filled?: boolean;
  /** Smooth (cubic) vs jagged (linear). */
  smooth?: boolean;
  /** Drop a marker at the most recent point. */
  showLastDot?: boolean;
  /** Stable id (used for the gradient stop) — prevents conflicts when
   *  multiple sparklines render on the same page. */
  gradientId?: string;
}

/**
 * Tiny line chart for trend data — ported from `primitives.jsx:220–243`.
 *
 * SVG path is built deterministically from `points`, so identical input
 * always produces an identical render (useful for placeholder data
 * seeded by a stable id).
 */
export function Sparkline({
  points,
  color = 'var(--brand-primary)',
  width = 360,
  height = 110,
  filled = true,
  smooth = false,
  showLastDot = true,
  gradientId,
}: SparklineProps): React.ReactElement | null {
  if (!points || points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const padTop = 6;
  const padBot = 8;
  const yFor = (v: number): number =>
    height - padBot - ((v - min) / range) * (height - padTop - padBot);

  const coords = points.map((v, i) => [i * step, yFor(v)] as [number, number]);

  let pathD: string;
  if (smooth) {
    // Catmull-Rom-ish smoothing — connect each pair with a quadratic
    // through the midpoint. Cheap and good-enough for sparklines.
    const parts: string[] = [`M ${coords[0]![0]},${coords[0]![1]}`];
    for (let i = 1; i < coords.length; i++) {
      const [x, y] = coords[i]!;
      const [px, py] = coords[i - 1]!;
      const mx = (px + x) / 2;
      parts.push(`Q ${px},${py} ${mx},${(py + y) / 2}`);
      parts.push(`T ${x},${y}`);
    }
    pathD = parts.join(' ');
  } else {
    pathD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x},${y}`).join(' ');
  }

  const areaD = `${pathD} L ${width},${height} L 0,${height} Z`;
  const id = gradientId ?? `spark-${Math.random().toString(36).slice(2, 9)}`;
  const lastX = coords[coords.length - 1]?.[0] ?? 0;
  const lastY = coords[coords.length - 1]?.[1] ?? 0;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height }}
      role="img"
      aria-label="trend chart"
    >
      {filled && (
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.18" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {filled && <path d={areaD} fill={`url(#${id})`} />}
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {showLastDot && <circle cx={lastX} cy={lastY} r={3} fill={color} />}
    </svg>
  );
}

/**
 * Build a deterministic random-walk series from a string seed. Used to
 * render sample data that's stable per profile / per ID until real data
 * lands.
 */
export function seededRandomWalk(seed: string, length: number, base = 100): number[] {
  // Simple 32-bit FNV hash — enough entropy for a sparkline.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rng = (): number => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) / 0xffffffff);
  };
  const out: number[] = [];
  let cur = base;
  for (let i = 0; i < length; i++) {
    cur += (rng() - 0.5) * (base * 0.08);
    cur = Math.max(base * 0.7, Math.min(base * 1.3, cur));
    out.push(Math.round(cur));
  }
  return out;
}
