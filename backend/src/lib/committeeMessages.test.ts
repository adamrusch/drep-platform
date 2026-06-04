import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { committeeMessages, buildCommitteeMessage, COMMITTEE_MSG_FORMAT } from './committeeMessages';

const W = 'addr1qxyz';
const N = 'deadbeef';

describe('committeeMessages (golden — issuer and verifier must agree byte-for-byte)', () => {
  it('format version is v1', () => {
    expect(COMMITTEE_MSG_FORMAT).toBe('v1');
  });

  it('cast message is exact', () => {
    expect(committeeMessages.cast('test', 'drep1', 'act#0', 'Agree', N, W)).toBe(
      'drep-platform committee vote [v1] (stage=test):\n\n' +
        `Wallet: ${W}\nCommittee: drep1\nAction: act#0\nVote: Agree\nNonce: ${N}`,
    );
  });

  it('proposal message is exact', () => {
    expect(committeeMessages.proposal('prod', 'drep1', 'act#0', 'No', N, W)).toBe(
      'drep-platform committee proposal [v1] (stage=prod):\n\n' +
        `Wallet: ${W}\nCommittee: drep1\nAction: act#0\nPosition: No\nNonce: ${N}`,
    );
  });

  it('submit-receipt message binds the txHash', () => {
    expect(committeeMessages.submitReceipt('prod', 'drep1', 'act#0', 'abc123', N, W)).toBe(
      'drep-platform committee submit-receipt [v1] (stage=prod):\n\n' +
        `Wallet: ${W}\nCommittee: drep1\nAction: act#0\nTxHash: abc123\nNonce: ${N}`,
    );
  });

  it('ipfs-key message binds the committee', () => {
    expect(committeeMessages.ipfsKey('test', 'drep1', N, W)).toBe(
      'drep-platform committee ipfs-key [v1] (stage=test):\n\n' +
        `Wallet: ${W}\nCommittee: drep1\nNonce: ${N}`,
    );
  });

  it('invitation-response accept message binds Committee + Decision', () => {
    // A captured Accept signature cannot be replayed as a Reject — the
    // decision is embedded in the plaintext that gets signed.
    expect(committeeMessages.invitationResponse('test', 'drep1', 'accept', N, W)).toBe(
      'drep-platform committee invitation-response [v1] (stage=test):\n\n' +
        `Wallet: ${W}\nCommittee: drep1\nDecision: accept\nNonce: ${N}`,
    );
  });

  it('invitation-response reject message differs from accept (different plaintext, different signature)', () => {
    const accept = committeeMessages.invitationResponse('prod', 'drep1', 'accept', N, W);
    const reject = committeeMessages.invitationResponse('prod', 'drep1', 'reject', N, W);
    expect(accept).not.toBe(reject);
    expect(reject).toBe(
      'drep-platform committee invitation-response [v1] (stage=prod):\n\n' +
        `Wallet: ${W}\nCommittee: drep1\nDecision: reject\nNonce: ${N}`,
    );
  });

  it('embeds the stage so a test signature cannot verify on prod', () => {
    const onTest = committeeMessages.cast('test', 'd', 'a', 'Agree', N, W);
    const onProd = committeeMessages.cast('prod', 'd', 'a', 'Agree', N, W);
    expect(onTest).not.toBe(onProd);
    expect(onTest).toContain('(stage=test)');
    expect(onProd).toContain('(stage=prod)');
  });

  it('generic builder orders Wallet → fields → Nonce', () => {
    expect(buildCommitteeMessage('dev', 'x', [['A', '1'], ['B', '2']], N, W)).toBe(
      `drep-platform committee x [v1] (stage=dev):\n\nWallet: ${W}\nA: 1\nB: 2\nNonce: ${N}`,
    );
  });

  // Drift guard: the canonical shared/ copy and the frontend copy MUST be
  // byte-identical to this backend copy, or the wallet will sign a string the
  // verifier never reconstructs.
  it('backend copy is byte-identical to shared/ and frontend copies', () => {
    const here = readFileSync(resolve(__dirname, 'committeeMessages.ts'), 'utf8');
    const sharedCopy = readFileSync(
      resolve(__dirname, '../../../shared/committeeMessages.ts'),
      'utf8',
    );
    const frontendCopy = readFileSync(
      resolve(__dirname, '../../../frontend/src/lib/committeeMessages.ts'),
      'utf8',
    );
    expect(here).toBe(sharedCopy);
    expect(here).toBe(frontendCopy);
  });
});
