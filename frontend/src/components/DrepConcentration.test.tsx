// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com),
// Apache-2.0. Modified for drep-platform.
//
// Smoke test for the voting-power concentration donut. Asserts the
// summary sentence and that the threshold markers render as buttons —
// the underlying math is covered separately in `lib/concentrationView.ts`
// pure-function tests.

import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import DrepConcentration from './DrepConcentration';
import type {
  ConcentrationPoint,
  ConcentrationTop,
} from '@/lib/concentrationView';

function buildByPercent(): ConcentrationPoint[] {
  // Synthetic concentration: 1 DRep at 50%, then 100 small ones.
  // byPercent[50].count === 1, byPercent[51].count starts climbing.
  return Array.from({ length: 101 }, (_, p) => {
    if (p <= 50) return { count: p === 0 ? 0 : 1, cumPct: p === 0 ? 0 : 50 };
    return { count: 1 + (p - 50), cumPct: 50 + (p - 50) * 0.5 };
  });
}

describe('DrepConcentration', () => {
  const topK: ConcentrationTop[] = [
    { drepId: 'drep1aaaaaaaaaaaaaaa', name: 'Alice', powerLabel: '500K ₳', pct: 50 },
    { drepId: 'drep1bbbbbbbbbbbbbbb', name: 'Bob', powerLabel: '100K ₳', pct: 10 },
  ];
  const markers = [
    { pct: 60, actions: ['No-confidence motion'] },
    { pct: 67, actions: ['Treasury withdrawal', 'Hard fork'] },
    { pct: 75, actions: ['Update committee (normal)'] },
  ];

  it('renders the summary sentence and the top legend', () => {
    const { getByText, getAllByRole } = render(
      <DrepConcentration
        topK={topK}
        byPercent={buildByPercent()}
        drepCount={101}
        totalLabel="1,000,000 ₳"
        markers={markers}
        defaultThresholdPct={67}
        thresholdsAsOf="2026-06-01T00:00:00.000Z"
      />,
    );
    // The component uses the rendered threshold to compute the sentence
    // — initial threshold is the supplied default (67). With the synthetic
    // byPercent (count = 1 + (p-50) for p > 50), 67% needs 18 DReps.
    expect(getByText(/Top 18 DReps hold 67% of active DRep voting power/)).toBeInTheDocument();
    expect(getByText('Alice')).toBeInTheDocument();
    expect(getByText('Bob')).toBeInTheDocument();

    // Threshold marker buttons (60/67/75%) render with their percent labels.
    const buttons = getAllByRole('button');
    const labels = buttons.map((b) => b.textContent).filter(Boolean);
    expect(labels).toContain('60%');
    expect(labels).toContain('67%');
    expect(labels).toContain('75%');
  });

  it('snaps to a threshold marker when the corresponding button is clicked', () => {
    const { getByRole, getByText } = render(
      <DrepConcentration
        topK={topK}
        byPercent={buildByPercent()}
        drepCount={101}
        totalLabel="1,000,000 ₳"
        markers={markers}
        defaultThresholdPct={67}
        thresholdsAsOf={null}
      />,
    );
    // Click the 75% marker — the sentence should update. With the
    // synthetic byPercent: count[75] = 1 + (75-50) = 26.
    fireEvent.click(getByRole('button', { name: '75%' }));
    expect(getByText(/Top 26 DReps hold 75% of active DRep voting power/)).toBeInTheDocument();
  });
});
