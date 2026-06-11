/**
 * Tests for the /help/data-freshness page.
 *
 * The page renders the canonical FRESHNESS table from `frontend/src/lib/freshness.ts`,
 * which is a byte-identical mirror of `shared/freshness.ts` (and the
 * infra mirror that drives the SchedulerStack). These tests confirm:
 *
 *   - The page renders without crashing under jsdom.
 *   - Every freshness row in the source-of-truth table appears in the DOM.
 *   - The freshness table is present (data-testid attribute), so future
 *     refactors can't silently drop the table.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelpDataFreshness } from './HelpDataFreshness';
import { FRESHNESS } from '@/lib/freshness';

describe('HelpDataFreshness', () => {
  it('renders the freshness table', () => {
    const { getByTestId } = render(
      <MemoryRouter>
        <HelpDataFreshness />
      </MemoryRouter>,
    );
    expect(getByTestId('freshness-table')).toBeInTheDocument();
  });

  it('renders a row for every canonical freshness entry', () => {
    const { getByTestId } = render(
      <MemoryRouter>
        <HelpDataFreshness />
      </MemoryRouter>,
    );
    for (const row of FRESHNESS) {
      expect(getByTestId(`freshness-row-${row.id}`)).toBeInTheDocument();
    }
  });

  it('shows each row’s label and cadence text', () => {
    const { getByText, getAllByText } = render(
      <MemoryRouter>
        <HelpDataFreshness />
      </MemoryRouter>,
    );
    for (const row of FRESHNESS) {
      // Labels are unique per row, so getByText is exact. Cadences are
      // intentionally not unique — e.g. "Hourly" appears for both
      // cc-members and committee-epoch-sweep — so we use getAllByText
      // and just assert ≥1 match.
      expect(getByText(row.label)).toBeInTheDocument();
      expect(getAllByText(row.cadence).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders all 9 schedule rows (sanity)', () => {
    const { container } = render(
      <MemoryRouter>
        <HelpDataFreshness />
      </MemoryRouter>,
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(FRESHNESS.length);
    // FRESHNESS.length is asserted equal to 9 explicitly so a regression
    // that drops or duplicates a row is caught here even if the source
    // table is also wrong in the same direction.
    expect(FRESHNESS.length).toBe(9);
  });
});
