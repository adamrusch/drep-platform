import { describe, it, expect } from 'vitest';
import { normalizeToStakeAddress, decodeCardanoAddress } from './cardanoAddress';

describe('normalizeToStakeAddress', () => {
  const stake = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
  // A real mainnet base address (payment key + stake key).
  const payment =
    'addr1q8utcf6x4tkvszqwkv46nqerpjc6d86e9xe7z59nnkfzzm5u267q5v8emt0ltmneqyfd3a82ucep6v5n08tky85pvarqq8emrr';

  it('returns a stake address unchanged (idempotent, canonical)', () => {
    expect(normalizeToStakeAddress(stake)).toBe(stake);
  });

  it('maps a base address to a stake address with the SAME stake credential', () => {
    const out = normalizeToStakeAddress(payment);
    expect(out).toBeTruthy();
    expect(out).toMatch(/^stake1[0-9a-z]+$/);

    // The derived stake address must carry the base address's stake credential.
    const basePart = decodeCardanoAddress(payment).stakeCredential;
    const stakePart = decodeCardanoAddress(out as string).stakeCredential;
    expect(basePart).toBeDefined();
    expect(stakePart).toBeDefined();
    expect(Buffer.from(stakePart as Buffer).toString('hex')).toBe(
      Buffer.from(basePart as Buffer).toString('hex'),
    );
  });

  it('returns null for a non-address / malformed input', () => {
    expect(normalizeToStakeAddress('not-an-address')).toBeNull();
    expect(normalizeToStakeAddress('')).toBeNull();
    expect(normalizeToStakeAddress('drep1abc')).toBeNull();
  });

  it('produces a well-formed mainnet stake1 of the canonical length', () => {
    const out = normalizeToStakeAddress(stake);
    expect(out).toMatch(/^stake1[0-9a-z]+$/);
    expect(out?.length).toBe(stake.length);
  });
});
