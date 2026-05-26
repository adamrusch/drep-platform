/**
 * Canonical fixture test for the support-level aggregation math.
 *
 * The displayed "Support Level: ±X ADA" is `sum(up.lovelace) -
 * sum(down.lovelace)` across all active votes on a comment. We store
 * this denormalized on the comments row (`supportLovelace`) to avoid
 * fan-out on the list read path. The denormalized counter MUST track
 * the canonical sum exactly.
 *
 * This file pins the math via a one-fixture-many-deltas table. Each
 * row in `CASES` is a sequence of voter actions; we assert the running
 * `supportLovelace` after each action matches `sum(up) - sum(down)`
 * computed from scratch over the surviving vote rows.
 *
 * # Why this lives next to the vote handler, not in lib/
 *
 * The aggregation math is enacted by the handler (delta application),
 * not by a library helper. The math is small enough to live inline.
 * Pulling it out into `lib/supportLevel.ts` for the sake of one test
 * would be premature abstraction.
 */

import { describe, it, expect } from 'vitest';

/** One voter's act in the simulation. */
interface VoteAction {
  voter: string;
  /** `null` = remove. */
  next: 'up' | 'down' | null;
  /** Lovelace AT THE MOMENT of this action — represents the snapshot
   *  the vote handler would take from `lookupStake`. */
  lovelace: bigint;
}

/** Per-voter state in the simulated "comment_votes" store. */
type VoteState = Map<string, { vote: 'up' | 'down'; lovelace: bigint }>;

/** Compute the canonical support level from the surviving vote rows. */
function aggregate(state: VoteState): bigint {
  let s = 0n;
  for (const v of state.values()) {
    s += v.vote === 'up' ? v.lovelace : -v.lovelace;
  }
  return s;
}

/**
 * Apply one action and update the running denormalized counter using
 * the SAME delta math the handler uses. Returns the new counter and
 * the (possibly updated) state map.
 */
function applyAction(
  counter: bigint,
  state: VoteState,
  action: VoteAction,
): { counter: bigint; state: VoteState } {
  const prior = state.get(action.voter);
  const next = state;
  let priorContribution = 0n;
  if (prior) priorContribution = prior.vote === 'up' ? prior.lovelace : -prior.lovelace;

  if (action.next === null) {
    // Remove.
    if (!prior) return { counter, state: next };
    next.delete(action.voter);
    return { counter: counter - priorContribution, state: next };
  }

  const newContribution =
    action.next === 'up' ? action.lovelace : -action.lovelace;
  const delta = newContribution - priorContribution;
  next.set(action.voter, { vote: action.next, lovelace: action.lovelace });
  return { counter: counter + delta, state: next };
}

interface FixtureCase {
  name: string;
  /** Seed-vote on comment creation: author seed lovelace counts as +author. */
  seedAuthor: string;
  seedLovelace: bigint;
  actions: VoteAction[];
  expectedFinal: bigint;
}

const CASES: FixtureCase[] = [
  {
    name: 'three upvotes minus two downvotes, mixed lovelaces',
    seedAuthor: 'authorAA',
    seedLovelace: 500_000_000_000n, // 500K ADA author seed
    actions: [
      { voter: 'voterBB', next: 'up', lovelace: 1_000_000_000_000n }, // +1M
      { voter: 'voterCC', next: 'up', lovelace: 2_000_000_000_000n }, // +2M
      { voter: 'voterDD', next: 'down', lovelace: 500_000_000_000n }, // -500K
      { voter: 'voterEE', next: 'down', lovelace: 100_000_000_000n }, // -100K
    ],
    // Author seed: +500K. Voters: +1M +2M -500K -100K = +2.4M.
    // Total: 500K + 2.4M = 2.9M ADA = 2_900_000_000_000 lovelace.
    expectedFinal: 2_900_000_000_000n,
  },
  {
    name: 'recast up to down with a different lovelace snapshot',
    seedAuthor: 'authorAA',
    seedLovelace: 100_000_000_000n,
    actions: [
      { voter: 'voterBB', next: 'up', lovelace: 1_000_000_000_000n },
      // Recast: voterBB now downvotes, and their stake has changed.
      // Both the direction and the snapshot move.
      { voter: 'voterBB', next: 'down', lovelace: 800_000_000_000n },
    ],
    // Author seed: +100K. voterBB final state: -800K. Total: -700K.
    expectedFinal: -700_000_000_000n,
  },
  {
    name: 'remove vote',
    seedAuthor: 'authorAA',
    seedLovelace: 1_000_000_000_000n,
    actions: [
      { voter: 'voterBB', next: 'up', lovelace: 500_000_000_000n },
      { voter: 'voterCC', next: 'down', lovelace: 200_000_000_000n },
      // voterBB changes their mind, withdraws their vote entirely.
      { voter: 'voterBB', next: null, lovelace: 0n },
    ],
    // Author: +1M. voterCC: -200K. voterBB: removed (0).
    // Total: 1M - 200K = 800K = 800_000_000_000.
    expectedFinal: 800_000_000_000n,
  },
  {
    name: 'idempotent same-vote (no-op)',
    seedAuthor: 'authorAA',
    seedLovelace: 100_000_000_000n,
    actions: [
      { voter: 'voterBB', next: 'up', lovelace: 500_000_000_000n },
      // Same direction, same lovelace — handler short-circuits, counter
      // does not move. The simulator naturally produces the same result
      // because `delta = newContribution - priorContribution = 0`.
      { voter: 'voterBB', next: 'up', lovelace: 500_000_000_000n },
    ],
    expectedFinal: 600_000_000_000n,
  },
  {
    name: 'mixed actions converge to zero when balanced',
    seedAuthor: 'authorAA',
    seedLovelace: 1_000_000_000_000n,
    actions: [
      { voter: 'voterBB', next: 'down', lovelace: 1_000_000_000_000n },
      // Author seed (+1M) + voterBB (-1M) = 0.
    ],
    expectedFinal: 0n,
  },
];

describe('comment support-level aggregation', () => {
  for (const c of CASES) {
    it(c.name, () => {
      // Seed: author's implicit upvote on comment creation.
      let counter = c.seedLovelace;
      const state: VoteState = new Map();
      state.set(c.seedAuthor, { vote: 'up', lovelace: c.seedLovelace });

      for (const action of c.actions) {
        const result = applyAction(counter, state, action);
        counter = result.counter;
        // After every step, the delta-counter MUST equal the canonical
        // sum-on-read aggregation. If this ever drifts, the denormalized
        // counter is broken — that's a release-blocker.
        expect(counter).toBe(aggregate(state));
      }

      expect(counter).toBe(c.expectedFinal);
      expect(aggregate(state)).toBe(c.expectedFinal);
    });
  }
});
