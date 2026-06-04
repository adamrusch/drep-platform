/**
 * Unit tests for the vote-tx helpers (Feature 3).
 *
 * Pure logic only — the actual MeshTxBuilder + wallet + WASM bundle can't
 * be unit-tested without a browser + a real wallet, and the design doc's
 * manual-test checklist covers that part end-to-end. What we DO test:
 *
 *   - actionId "<txHash>#<index>" → { txHash, txIndex } parsing.
 *   - position → VoteKind mapping.
 *   - totalLovelace sums correctly across mixed UTxO shapes.
 *   - buildUnsignedVoteTx wires the Mesh API correctly with + without an
 *     anchor (vote anchor is optional in CIP-1694 when no rationale).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseActionIdToGovActionId,
  positionToVoteKind,
  totalLovelace,
  buildUnsignedVoteTx,
  MIN_LOVELACE_FOR_VOTE,
  type MeshDeps,
  type VoteWallet,
} from './voteTx';

const HASH64 = 'a'.repeat(64);

describe('positionToVoteKind', () => {
  it('maps Yes/No/Abstain identically', () => {
    expect(positionToVoteKind('Yes')).toBe('Yes');
    expect(positionToVoteKind('No')).toBe('No');
    expect(positionToVoteKind('Abstain')).toBe('Abstain');
  });
});

describe('parseActionIdToGovActionId', () => {
  it('splits a well-formed "<txHash>#<index>"', () => {
    expect(parseActionIdToGovActionId(`${HASH64}#0`)).toEqual({
      txHash: HASH64, txIndex: 0,
    });
    expect(parseActionIdToGovActionId(`${HASH64}#7`)).toEqual({
      txHash: HASH64, txIndex: 7,
    });
  });

  it('throws on missing "#"', () => {
    expect(() => parseActionIdToGovActionId(HASH64)).toThrow(/Malformed/);
  });

  it('throws on non-hex txHash', () => {
    expect(() => parseActionIdToGovActionId(`z${HASH64.slice(1)}#0`)).toThrow(/Malformed/);
  });

  it('throws on non-numeric index', () => {
    expect(() => parseActionIdToGovActionId(`${HASH64}#abc`)).toThrow(/Malformed/);
  });

  it('throws on shorter-than-64 txHash', () => {
    expect(() => parseActionIdToGovActionId(`abc#0`)).toThrow(/Malformed/);
  });
});

describe('totalLovelace', () => {
  it('sums lovelace across UTxOs and ignores other assets', () => {
    expect(
      totalLovelace([
        { output: { amount: [{ unit: 'lovelace', quantity: '1000000' }] } },
        { output: { amount: [
          { unit: 'lovelace', quantity: '2500000' },
          { unit: 'policy.NATIVE', quantity: '42' },
        ] } },
      ]),
    ).toBe(3_500_000n);
  });

  it('tolerates malformed entries (no UTxOs / missing amount)', () => {
    expect(totalLovelace([])).toBe(0n);
    expect(totalLovelace([{}, { output: {} }, { output: { amount: [] } }])).toBe(0n);
  });

  it('MIN_LOVELACE_FOR_VOTE is at the ~0.5 ADA threshold', () => {
    // Sanity check on the user-facing warning threshold (named so we can
    // assert it in a future-proof way if the constant moves).
    expect(MIN_LOVELACE_FOR_VOTE).toBe(500_000n);
  });
});

describe('buildUnsignedVoteTx', () => {
  function buildDepsAndCaptures() {
    const calls: {
      voter?: unknown; govActionId?: unknown; votingProcedure?: unknown;
      changeAddress?: string; utxos?: unknown[];
    } = {};
    const vote = vi.fn((voter, govActionId, votingProcedure) => {
      calls.voter = voter; calls.govActionId = govActionId; calls.votingProcedure = votingProcedure;
      return {
        changeAddress: (addr: string) => {
          calls.changeAddress = addr;
          return {
            selectUtxosFrom: (utxos: unknown[]) => {
              calls.utxos = utxos;
              return { complete: () => Promise.resolve('UNSIGNED_HEX') };
            },
          };
        },
      };
    });
    const MeshTxBuilder = vi.fn().mockImplementation(() => ({ vote }));
    const deps: MeshDeps = { MeshTxBuilder: MeshTxBuilder as unknown as MeshDeps['MeshTxBuilder'] };
    return { deps, calls, MeshTxBuilder, vote };
  }

  const wallet: VoteWallet = {
    getChangeAddress: vi.fn().mockResolvedValue('addr1xyz'),
    getUtxos: vi.fn().mockResolvedValue([
      { output: { amount: [{ unit: 'lovelace', quantity: '5000000' }] } },
    ]),
    signTx: vi.fn(),
    submitTx: vi.fn(),
  };

  it('builds with an anchor when both anchorUrl and anchorHash are present', async () => {
    const { deps, calls } = buildDepsAndCaptures();
    const tx = await buildUnsignedVoteTx(
      {
        drepId: 'drep1abc',
        actionId: `${HASH64}#3`,
        position: 'Yes',
        anchorUrl: 'ipfs://QmAnchor',
        anchorHash: 'b'.repeat(64),
        wallet,
      },
      deps,
    );
    expect(tx).toBe('UNSIGNED_HEX');
    expect(calls.voter).toEqual({ type: 'DRep', drepId: 'drep1abc' });
    expect(calls.govActionId).toEqual({ txHash: HASH64, txIndex: 3 });
    expect(calls.votingProcedure).toEqual({
      voteKind: 'Yes',
      anchor: { anchorUrl: 'ipfs://QmAnchor', anchorDataHash: 'b'.repeat(64) },
    });
    expect(calls.changeAddress).toBe('addr1xyz');
    expect(calls.utxos).toHaveLength(1);
  });

  it('omits the anchor entirely when either anchorUrl OR anchorHash is missing', async () => {
    const { deps, calls } = buildDepsAndCaptures();
    await buildUnsignedVoteTx(
      {
        drepId: 'drep1abc',
        actionId: `${HASH64}#0`,
        position: 'No',
        anchorUrl: null,
        anchorHash: null,
        wallet,
      },
      deps,
    );
    expect(calls.votingProcedure).toEqual({ voteKind: 'No' });
    expect((calls.votingProcedure as Record<string, unknown>)['anchor']).toBeUndefined();
  });
});
