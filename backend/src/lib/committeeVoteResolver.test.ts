import { describe, it, expect } from 'vitest';
import { resolveCommitteeVote } from './committeeVoteResolver';
import type { CommitteeCastVote } from './types';

const cast = (voterWallet: string, vote: CommitteeCastVote) => ({ voterWallet, vote });

describe('resolveCommitteeVote — count-based "X of N"', () => {
  it('approves once Agree count reaches the threshold X', () => {
    const r = resolveCommitteeVote({
      casts: [cast('a', 'Agree'), cast('b', 'Agree'), cast('c', 'Agree')],
      approvalThreshold: 3,
      memberCount: 5,
    });
    expect(r.agreeCount).toBe(3);
    expect(r.isApproved).toBe(true);
    expect(r.canCloseAsPass).toBe(true);
    expect(r.isPassing).toBe(true);
    expect(r.agreeNeeded).toBe(0);
  });

  it('is NOT approved below X, and reports how many more Agrees are needed', () => {
    const r = resolveCommitteeVote({
      casts: [cast('a', 'Agree'), cast('b', 'Agree')],
      approvalThreshold: 3,
      memberCount: 5,
    });
    expect(r.agreeCount).toBe(2);
    expect(r.isApproved).toBe(false);
    expect(r.agreeNeeded).toBe(1);
  });

  it('abstentions and disagreements do NOT count toward approval', () => {
    const r = resolveCommitteeVote({
      casts: [
        cast('a', 'Agree'),
        cast('b', 'Disagree'),
        cast('c', 'Abstain'),
        cast('d', 'Abstain'),
        cast('e', 'Disagree'),
      ],
      approvalThreshold: 3,
      memberCount: 5,
    });
    expect(r.agreeCount).toBe(1);
    expect(r.disagreeCount).toBe(2);
    expect(r.abstainCount).toBe(2);
    expect(r.isApproved).toBe(false);
    expect(r.agreeNeeded).toBe(2);
  });

  it('X = N requires unanimous Agree', () => {
    const four = [cast('a', 'Agree'), cast('b', 'Agree'), cast('c', 'Agree'), cast('d', 'Agree')];
    expect(resolveCommitteeVote({ casts: four, approvalThreshold: 5, memberCount: 5 }).isApproved).toBe(false);
    expect(
      resolveCommitteeVote({ casts: [...four, cast('e', 'Agree')], approvalThreshold: 5, memberCount: 5 }).isApproved,
    ).toBe(true);
  });

  it('X = 1 approves on the first Agree', () => {
    expect(
      resolveCommitteeVote({ casts: [cast('a', 'Agree')], approvalThreshold: 1, memberCount: 3 }).isApproved,
    ).toBe(true);
  });

  it('agreePct is agree / N (informational), 0 when N is 0', () => {
    expect(
      resolveCommitteeVote({ casts: [cast('a', 'Agree'), cast('b', 'Agree')], approvalThreshold: 3, memberCount: 4 })
        .agreePct,
    ).toBe(50);
    expect(resolveCommitteeVote({ casts: [], approvalThreshold: 1, memberCount: 0 }).agreePct).toBe(0);
  });

  it('keeps the last cast per voter (vote changes)', () => {
    const r = resolveCommitteeVote({
      casts: [cast('a', 'Agree'), cast('a', 'Disagree'), cast('b', 'Agree'), cast('c', 'Agree')],
      approvalThreshold: 3,
      memberCount: 5,
    });
    expect(r.agreeCount).toBe(2);
    expect(r.disagreeCount).toBe(1);
    expect(r.isApproved).toBe(false);
  });

  it('clamps a nonsensical threshold/memberCount to safe minimums', () => {
    const r = resolveCommitteeVote({ casts: [cast('a', 'Agree')], approvalThreshold: 0, memberCount: -2 });
    expect(r.approvalThreshold).toBe(1);
    expect(r.memberCount).toBe(0);
    expect(r.isApproved).toBe(true);
  });
});
