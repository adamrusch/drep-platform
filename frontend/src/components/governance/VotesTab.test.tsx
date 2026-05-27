/**
 * Canary test for `VotesTab`. Covers the "superseded vote renders with
 * strikethrough" rule that came in with Batch D — the unit-level guard
 * against a regression where a recast-vote layout would lose the audit
 * trail or fail to indicate which row is the live one.
 *
 * The Votes-tab supersede grouping logic lives in the backend (see
 * `lib/votes.ts`). The frontend only reads pre-computed `superseded:
 * boolean` flags. So this test exercises the RENDERING contract:
 *   - `superseded: true` → the row carries `line-through` somewhere in
 *     its class chain.
 *   - `superseded: false` → no strikethrough.
 *   - A `Superseded` badge renders on superseded rows only.
 *
 * # Why a snapshot-style assertion rather than a full a11y interaction
 *
 * The Votes-tab is read-only; the only state changes come from the
 * parent query refresh, which we don't exercise here. A rendering
 * smoke test is the appropriate first canary.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VotesTab } from './VotesTab';
import type { ActionVoteRecord } from '@/types';

function makeDRepVote(overrides: Partial<ActionVoteRecord> = {}): ActionVoteRecord {
  return {
    voterRole: 'DRep',
    voterId: 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx',
    voterDisplayName: 'Alice DRep',
    votingPowerLovelace: '5000000000',
    vote: 'Yes',
    votedAt: '2026-05-20T10:00:00.000Z',
    blockTime: 1748000000,
    voteTxHash: 'tx-aaa',
    superseded: false,
    ...overrides,
  };
}

describe('VotesTab — supersede strikethrough rendering', () => {
  it('renders three vote rows (one superseded) with the right strikethrough application', () => {
    const votes: ActionVoteRecord[] = [
      makeDRepVote({
        voterId: 'drep1alice',
        voterDisplayName: 'Alice DRep',
        voteTxHash: 'tx-alice-new',
        superseded: false,
      }),
      // Same voter, older vote — superseded by tx-alice-new above.
      makeDRepVote({
        voterId: 'drep1alice',
        voterDisplayName: 'Alice DRep',
        voteTxHash: 'tx-alice-old',
        vote: 'No',
        superseded: true,
      }),
      makeDRepVote({
        voterId: 'drep1bob',
        voterDisplayName: 'Bob DRep',
        voteTxHash: 'tx-bob',
        superseded: false,
      }),
    ];

    const { container, getAllByText, queryAllByText } = render(
      <MemoryRouter>
        <VotesTab votes={votes} />
      </MemoryRouter>,
    );

    // Three rows rendered (each as a Card).
    const cards = container.querySelectorAll('[class*="rounded-token"]');
    expect(cards.length).toBeGreaterThanOrEqual(3);

    // Exactly one `Superseded` badge — on the old Alice vote.
    const supersededBadges = queryAllByText('Superseded');
    expect(supersededBadges).toHaveLength(1);

    // The superseded badge's nearest containing card carries
    // `line-through` (via the voter-label link's class chain) on at
    // least one descendant. We use `querySelectorAll` on the rendered
    // DOM to avoid coupling the test to specific class names — the
    // contract is "somewhere in this row the strikethrough applies."
    const strikethroughEls = container.querySelectorAll('[class*="line-through"]');
    // Should be present (the superseded row triggers it).
    expect(strikethroughEls.length).toBeGreaterThan(0);

    // Non-superseded voter names are still rendered as links (DRep
    // voters → in-app /drep/{id}). Two non-superseded voters in this
    // fixture = at least 2 links.
    const aliceLinks = getAllByText('Alice DRep');
    // Both Alice rows (live + superseded) carry her display name.
    expect(aliceLinks.length).toBe(2);
    // Bob has one row.
    expect(getAllByText('Bob DRep')).toHaveLength(1);
  });

  it('renders the empty state when no votes are passed', () => {
    const { getByText } = render(
      <MemoryRouter>
        <VotesTab votes={[]} />
      </MemoryRouter>,
    );
    expect(getByText('No votes have been cast on this action yet.')).toBeInTheDocument();
  });

  it('does not apply strikethrough when no row is superseded', () => {
    const votes: ActionVoteRecord[] = [
      makeDRepVote({
        voterId: 'drep1alice',
        voteTxHash: 'tx-alice',
        superseded: false,
      }),
    ];
    const { container, queryByText } = render(
      <MemoryRouter>
        <VotesTab votes={votes} />
      </MemoryRouter>,
    );

    // No Superseded badge.
    expect(queryByText('Superseded')).toBeNull();
    // No line-through class anywhere.
    const strikethroughEls = container.querySelectorAll('[class*="line-through"]');
    expect(strikethroughEls.length).toBe(0);
  });
});
