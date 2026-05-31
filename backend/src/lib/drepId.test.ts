import { describe, it, expect } from 'vitest';
import { drepIdFromCredentialHashHex } from './drepId';

describe('drepIdFromCredentialHashHex (CIP-129)', () => {
  it('derives the real Silence Dogood DRep id from its credential hash', () => {
    // Credential hash 239ce448… (from Koios drep_info) must encode to the
    // on-chain drep id — proves the 0x22 header + bech32 encoding is correct.
    expect(
      drepIdFromCredentialHashHex('239ce448ea7e7678bbac8f2052583a44802ea50e5de2c7aae77e648e'),
    ).toBe('drep1yg3eeezgafl8v79m4j8jq5jc8fzgqt49pew793a2ualxfrswke8zd');
  });

  it('rejects a wrong-length credential', () => {
    expect(() => drepIdFromCredentialHashHex('deadbeef')).toThrow();
  });
});
