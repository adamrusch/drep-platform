import { describe, it, expect } from 'vitest';
import { resolveCommitteeVote } from './committeeVoteResolver';
import type { CommitteeCastVote } from './types';

type Cast = { voterWallet: string; vote: CommitteeCastVote };

/** Build N Agree, M Disagree, K Abstain casts with unique wallets. */
function casts(agree: number, disagree: number, abstain: number): Cast[] {
  const out: Cast[] = [];
  let i = 0;
  for (let a = 0; a < agree; a++) out.push({ voterWallet: `w${i++}`, vote: 'Agree' });
  for (let d = 0; d < disagree; d++) out.push({ voterWallet: `w${i++}`, vote: 'Disagree' });
  for (let k = 0; k < abstain; k++) out.push({ voterWallet: `w${i++}`, vote: 'Abstain' });
  return out;
}

const QUORUM = 3;

describe('resolveCommitteeVote', () => {
  it('no votes → no quorum, not passing', () => {
    const r = resolveCommitteeVote({ casts: [], thresholdPct: 67, quorum: QUORUM });
    expect(r).toMatchObject({ activePool: 0, quorumMet: false, isPassing: false, canCloseAsPass: false, agreePct: 0 });
  });

  it('below quorum cannot pass even if unanimous', () => {
    const r = resolveCommitteeVote({ casts: casts(2, 0, 0), thresholdPct: 67, quorum: QUORUM });
    expect(r.activePool).toBe(2);
    expect(r.quorumMet).toBe(false);
    expect(r.isPassing).toBe(false);
  });

  it('3 agree / 0 disagree @67% → passing', () => {
    const r = resolveCommitteeVote({ casts: casts(3, 0, 0), thresholdPct: 67, quorum: QUORUM });
    expect(r).toMatchObject({ activePool: 3, quorumMet: true, agreePct: 100, isPassing: true, canCloseAsPass: true });
  });

  it('2 agree / 1 disagree @67% → 66.7% < 67% → NOT passing', () => {
    const r = resolveCommitteeVote({ casts: casts(2, 1, 0), thresholdPct: 67, quorum: QUORUM });
    expect(r.activePool).toBe(3);
    expect(r.isPassing).toBe(false);
  });

  it('2 agree / 1 disagree @51% → simple majority → passing', () => {
    const r = resolveCommitteeVote({ casts: casts(2, 1, 0), thresholdPct: 51, quorum: QUORUM });
    expect(r.isPassing).toBe(true);
  });

  it('abstain shrinks the pool, making passage easier (5/2/3 @67%)', () => {
    // activePool = 5 + 2 = 7; abstainers excluded. 5/7 = 71.4% >= 67% → passing.
    const r = resolveCommitteeVote({ casts: casts(5, 2, 3), thresholdPct: 67, quorum: QUORUM });
    expect(r.activePool).toBe(7);
    expect(r.abstainCount).toBe(3);
    expect(r.isPassing).toBe(true);
  });

  it('all-abstain → activePool 0, never passing', () => {
    const r = resolveCommitteeVote({ casts: casts(0, 0, 5), thresholdPct: 67, quorum: QUORUM });
    expect(r.activePool).toBe(0);
    expect(r.quorumMet).toBe(false);
    expect(r.isPassing).toBe(false);
    expect(r.agreePct).toBe(0);
  });

  it('unanimous @100% threshold → passing', () => {
    const r = resolveCommitteeVote({ casts: casts(4, 0, 0), thresholdPct: 100, quorum: QUORUM });
    expect(r.isPassing).toBe(true);
  });

  it('one dissenter @100% threshold → not passing', () => {
    const r = resolveCommitteeVote({ casts: casts(3, 1, 0), thresholdPct: 100, quorum: QUORUM });
    expect(r.isPassing).toBe(false);
  });

  it('51% floor: 3 agree / 3 disagree → exactly 50% → NOT passing (defends simple-majority floor)', () => {
    const r = resolveCommitteeVote({ casts: casts(3, 3, 0), thresholdPct: 51, quorum: QUORUM });
    expect(r.agreePct).toBe(50);
    expect(r.isPassing).toBe(false);
  });

  it('51% == strict majority for an even pool (3 agree / 1 disagree → passing; 2/2 → not)', () => {
    expect(resolveCommitteeVote({ casts: casts(3, 1, 0), thresholdPct: 51, quorum: QUORUM }).isPassing).toBe(true);
    expect(resolveCommitteeVote({ casts: casts(2, 2, 0), thresholdPct: 51, quorum: QUORUM }).isPassing).toBe(false);
  });

  it('exact threshold boundary: 67/100 active agree @67% → passing (>=, not >)', () => {
    const r = resolveCommitteeVote({ casts: casts(67, 33, 0), thresholdPct: 67, quorum: QUORUM });
    expect(r.activePool).toBe(100);
    expect(r.agreePct).toBe(67);
    expect(r.isPassing).toBe(true);
  });

  it('just under exact threshold: 66/100 active agree @67% → not passing', () => {
    const r = resolveCommitteeVote({ casts: casts(66, 34, 0), thresholdPct: 67, quorum: QUORUM });
    expect(r.isPassing).toBe(false);
  });

  it('quorum exactly met with all agree → passing', () => {
    const r = resolveCommitteeVote({ casts: casts(3, 0, 0), thresholdPct: 67, quorum: 3 });
    expect(r.quorumMet).toBe(true);
    expect(r.isPassing).toBe(true);
  });

  it('dedupes repeated voter wallets, last cast wins', () => {
    const cs: Cast[] = [
      { voterWallet: 'a', vote: 'Disagree' },
      { voterWallet: 'a', vote: 'Agree' }, // a changed mind → Agree
      { voterWallet: 'b', vote: 'Agree' },
      { voterWallet: 'c', vote: 'Agree' },
    ];
    const r = resolveCommitteeVote({ casts: cs, thresholdPct: 67, quorum: QUORUM });
    expect(r.agreeCount).toBe(3);
    expect(r.disagreeCount).toBe(0);
    expect(r.activePool).toBe(3);
    expect(r.isPassing).toBe(true);
  });
});
