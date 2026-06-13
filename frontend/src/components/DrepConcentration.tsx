// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com),
// Apache-2.0. Modified for drep-platform.
//
// Voting-power concentration donut. Pure presentation — the math runs
// on the backend (`lib/dreps/concentration.ts`) and arrives JSON-shaped
// via `GET /dreps/concentration`. This component renders the donut,
// the top-K legend, the threshold slider, and the snap-to-marker
// behaviour. State is local; the donut is informational, not interactive
// outside its own surface.

import type React from 'react';
import { useMemo, useState } from 'react';
import {
  coalitionAt,
  snapThreshold,
  buildSegments,
  summarySentence,
  type DonutSegment,
} from '@/lib/concentrationView';
import { cn } from '@/lib/utils';

/** Mirror of the backend type (kept inline so this file doesn't depend
 *  on a shared type export — the concentration response shape is a
 *  small, narrowly-used surface). */
export interface ConcentrationTop {
  drepId: string;
  name: string | null;
  powerLabel: string;
  pct: number;
}
export interface ConcentrationPoint {
  count: number;
  cumPct: number;
}
export interface Concentration {
  drepCount: number;
  totalLabel: string;
  totalPower: string;
  topK: ConcentrationTop[];
  byPercent: ConcentrationPoint[];
}
export interface ThresholdMarker {
  pct: number;
  actions: string[];
}

interface Props {
  topK: Concentration['topK'];
  byPercent: Concentration['byPercent'];
  drepCount: number;
  totalLabel: string;
  markers: ThresholdMarker[];
  /** Initial slider position; the backend recommends a sensible value. */
  defaultThresholdPct: number;
  /** ISO-8601 of when the markers were captured; null when no snapshot
   *  was available. */
  thresholdsAsOf: string | null;
}

const SLIDER_MIN = 40;
const SLIDER_MAX = 90;
const R = 80; // donut radius in the 200x200 viewBox
const STROKE = 22;
const C = 2 * Math.PI * R;

/** Truncate a `drep1...` ID to a glance-readable form. */
function truncateId(drepId: string): string {
  if (drepId.length <= 18) return drepId;
  return `${drepId.slice(0, 12)}…${drepId.slice(-6)}`;
}

/** Decreasing-opacity accent shades for the individual top DRep slices. */
function topTone(i: number): string {
  const op = Math.max(0.4, 1 - i * 0.06);
  return `color-mix(in srgb, var(--brand-primary) ${Math.round(op * 100)}%, var(--bg-canvas))`;
}

function toneFor(kind: DonutSegment['kind'], index: number): string {
  if (kind === 'top') return topTone(index);
  if (kind === 'coalitionRest')
    return 'color-mix(in srgb, var(--brand-primary) 30%, var(--bg-canvas))';
  return 'var(--border-default)';
}

export default function DrepConcentration(props: Props): React.ReactElement {
  const { topK, byPercent, drepCount, totalLabel, markers, defaultThresholdPct, thresholdsAsOf } =
    props;
  const [threshold, setThreshold] = useState(defaultThresholdPct);

  const markersPct = markers.map((m) => m.pct);
  // The governance actions gated at the currently selected threshold, if
  // it sits exactly on a marker.
  const currentMarker = markers.find((m) => m.pct === threshold);

  const coalition = coalitionAt(byPercent, threshold);
  const segments = useMemo(() => buildSegments(topK, coalition), [topK, coalition]);

  // Cumulative start offset per drawn arc (the muted remainder is
  // skipped; the background track circle shows through instead).
  let start = 0;
  let topIdx = 0;
  const arcs = segments
    .filter((s) => s.kind !== 'remainder')
    .map((s) => {
      const dash = (s.pct / 100) * C;
      const offset = -(start / 100) * C;
      start += s.pct;
      const tone = toneFor(s.kind, topIdx);
      const key = s.kind === 'top' ? topK[topIdx]!.drepId : s.kind;
      if (s.kind === 'top') topIdx++;
      return { dash, offset, tone, key };
    });

  // Threshold tick: a short radial line at the selected percent (top is 0%).
  const tickRad = ((threshold / 100) * 360 - 90) * (Math.PI / 180);
  const inner = R - STROKE / 2 - 3;
  const outer = R + STROKE / 2 + 3;
  const tx1 = 100 + inner * Math.cos(tickRad);
  const ty1 = 100 + inner * Math.sin(tickRad);
  const tx2 = 100 + outer * Math.cos(tickRad);
  const ty2 = 100 + outer * Math.sin(tickRad);

  const thresholdsAsOfText = thresholdsAsOf
    ? new Date(thresholdsAsOf).toLocaleDateString()
    : null;

  return (
    <section
      id="concentration"
      className={cn(
        'bg-[var(--bg-canvas)] border border-[var(--border-default)] rounded-token-xl',
        'shadow-token-sm p-5 space-y-4',
      )}
      aria-labelledby="drep-conc-title"
    >
      <header className="space-y-1">
        <h2
          id="drep-conc-title"
          className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]"
        >
          Voting power concentration
        </h2>
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          {summarySentence(coalition.count, threshold)}. Total {totalLabel} across{' '}
          {drepCount.toLocaleString('en-US')} DReps.
        </p>
      </header>

      <div className="flex flex-col md:flex-row gap-6 md:items-start">
        {/* Left column: donut, slider, as-of */}
        <div className="space-y-3 flex-shrink-0">
          <div className="relative inline-block">
            <svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true">
              <circle
                cx="100"
                cy="100"
                r={R}
                fill="none"
                stroke="var(--border-default)"
                strokeWidth={STROKE}
                opacity="0.5"
              />
              <g transform="rotate(-90 100 100)">
                {arcs.map((a) => (
                  <circle
                    key={a.key}
                    cx="100"
                    cy="100"
                    r={R}
                    fill="none"
                    stroke={a.tone}
                    strokeWidth={STROKE}
                    strokeDasharray={`${a.dash} ${C - a.dash}`}
                    strokeDashoffset={a.offset}
                  />
                ))}
              </g>
              <line
                x1={tx1}
                y1={ty1}
                x2={tx2}
                y2={ty2}
                stroke="var(--text-primary)"
                strokeWidth="2"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-[24px] font-semibold tabular-nums text-[var(--text-primary)]">
                {coalition.count.toLocaleString('en-US')}
              </span>
              <span className="text-[11px] text-[var(--text-secondary)]">
                DReps = {threshold}%
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="drep-conc-slider"
              className="block text-[12px] text-[var(--text-secondary)]"
            >
              Threshold: {threshold}%
            </label>
            <input
              id="drep-conc-slider"
              type="range"
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              step={1}
              value={threshold}
              list="drep-conc-markers"
              onChange={(e) => setThreshold(snapThreshold(Number(e.target.value), markersPct))}
              className="w-full accent-[var(--brand-primary)]"
            />
            <datalist id="drep-conc-markers">
              {markersPct.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <div className="flex gap-2 flex-wrap">
              {markers.map((mk) => (
                <button
                  key={mk.pct}
                  type="button"
                  aria-pressed={threshold === mk.pct}
                  onClick={() => setThreshold(mk.pct)}
                  title={mk.actions.length ? mk.actions.join(', ') : undefined}
                  className={cn(
                    'inline-flex items-center justify-center min-w-[40px] h-7 px-2',
                    'rounded-token-md text-[12px] tabular-nums border transition-colors',
                    threshold === mk.pct
                      ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-[var(--bg-canvas)] font-semibold'
                      : 'border-[var(--border-default)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {mk.pct}%
                </button>
              ))}
            </div>
            {currentMarker && currentMarker.actions.length > 0 && (
              <p className="text-[12px] text-[var(--text-secondary)]">
                {threshold}% is the passing threshold for {currentMarker.actions.join(', ')}.
              </p>
            )}
            {thresholdsAsOfText && (
              <p className="text-[11px] text-[var(--text-tertiary)]">
                Thresholds as of {thresholdsAsOfText}.
              </p>
            )}
          </div>
        </div>

        {/* Right column: top DReps by share. Collapses below the donut on
            narrow screens via `flex-col` on the parent. */}
        <ol className="space-y-1 min-w-0 flex-1" aria-label="Top DReps by voting power">
          {topK.map((t, i) => (
            <li
              key={t.drepId}
              className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]"
            >
              <span
                className="inline-block w-3 h-3 rounded-token-sm flex-shrink-0"
                style={{ background: topTone(i) }}
                aria-hidden="true"
              />
              <a
                href={`/drep/${encodeURIComponent(t.drepId)}`}
                className="truncate text-[var(--text-primary)] hover:underline"
              >
                {t.name ?? truncateId(t.drepId)}
              </a>
              <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">
                {t.pct.toFixed(1)}%
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
