// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Tests for Cardano identity derivation: DRep IDs, stake addresses, and address binding.
import { describe, it, expect } from 'vitest';
import {
  drepIdFromKeyHash,
  drepIdFromPubKey,
  stakeAddressFromPubKey,
  keyHashMatchesAddress,
  isDrepCredentialAddress,
  drepCredentialAddress,
  cip105ToCip129,
  ccHotKeyHashHex,
  drepCredentialHexFromId,
} from './identity';
import { hexToBytes, bytesToHex } from '../crypto/hex';
import { decodeBech32, encodeBech32 } from '../crypto/bech32';

// From src/lib/identity/__fixtures__/cip8-vectors.json
const STAKE_VECTOR = {
  expectedPubKeyHex: '3a7a243a6b00e4a913d74a054984079299315828c366d1cc9cc88d06af742d5a',
  expectedStakeAddress: 'stake_test1uqpqhw7q2jcutnwteqnvdgqkjulnaa5ym8wh70kcu3yvkugckkcgj',
  addressHex: 'e0020bbbc054b1c5cdcbc826c6a016973f3ef684d9dd7f3ed8e448cb71',
};
const DREP_VECTOR = {
  expectedPubKeyHex: 'a1458f6a1e1763fc379d7593b855ea21066cc76b78bfb5860f17315c86b561f6',
  expectedDrepAddrHex: '22af4e07977b6c2683c065e17ec1ea0421ac7c2fc579f9dd98ff8e2f82',
};

describe('drepIdFromKeyHash', () => {
  it('encodes 28 zero bytes as the CIP-129 all-q drep id', () => {
    // CIP-129 canonical zero vector.
    const result = drepIdFromKeyHash(new Uint8Array(28));
    expect(result).toBe('drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n');
  });

  it('produces a drep bech32 string with prefix drep', () => {
    const result = drepIdFromKeyHash(new Uint8Array(28));
    expect(result.startsWith('drep1')).toBe(true);
  });
});

describe('drepIdFromPubKey', () => {
  it('derives the correct drep id for the fixture drep pubkey', () => {
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const drepId = drepIdFromPubKey(pubKey);
    // Decode and verify the payload hex matches the fixture.
    const { data } = decodeBech32(drepId);
    expect(bytesToHex(data)).toBe(DREP_VECTOR.expectedDrepAddrHex);
  });

  it('returns a string starting with drep1', () => {
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    expect(drepIdFromPubKey(pubKey).startsWith('drep1')).toBe(true);
  });
});

describe('stakeAddressFromPubKey', () => {
  it('derives the fixture preprod stake address from the fixture pubkey', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const result = stakeAddressFromPubKey(pubKey, 'preprod');
    expect(result).toBe(STAKE_VECTOR.expectedStakeAddress);
  });

  it('uses stake_test prefix for preprod', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const addr = stakeAddressFromPubKey(pubKey, 'preprod');
    expect(addr.startsWith('stake_test1')).toBe(true);
  });

  it('uses stake prefix for mainnet', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const addr = stakeAddressFromPubKey(pubKey, 'mainnet');
    expect(addr.startsWith('stake1')).toBe(true);
  });

  it('uses header 0xE0 for testnet and 0xE1 for mainnet', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const testnet = decodeBech32(stakeAddressFromPubKey(pubKey, 'preprod'));
    const mainnet = decodeBech32(stakeAddressFromPubKey(pubKey, 'mainnet'));
    expect(testnet.data[0]).toBe(0xe0);
    expect(mainnet.data[0]).toBe(0xe1);
  });
});

describe('keyHashMatchesAddress', () => {
  it('returns true when the pubkey hash matches a reward address', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const addrBytes = hexToBytes(STAKE_VECTOR.addressHex);
    expect(keyHashMatchesAddress(pubKey, addrBytes)).toBe(true);
  });

  it('returns false when a different pubkey is used against the same address', () => {
    const wrongPubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const addrBytes = hexToBytes(STAKE_VECTOR.addressHex);
    expect(keyHashMatchesAddress(wrongPubKey, addrBytes)).toBe(false);
  });

  it('matches via decoded fixture stake address bytes', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const { data: addrBytes } = decodeBech32(STAKE_VECTOR.expectedStakeAddress);
    expect(keyHashMatchesAddress(pubKey, addrBytes)).toBe(true);
  });

  it('returns true for a bare 28-byte DRep key hash (no header byte)', () => {
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const bareHash = hexToBytes(DREP_VECTOR.expectedDrepAddrHex.slice(2));
    expect(bareHash.length).toBe(28);
    expect(keyHashMatchesAddress(pubKey, bareHash)).toBe(true);
  });

  it('returns false for a bare 28-byte hash that does not match the pubkey', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const wrongHash = hexToBytes(DREP_VECTOR.expectedDrepAddrHex.slice(2));
    expect(keyHashMatchesAddress(pubKey, wrongHash)).toBe(false);
  });

  describe('base address (57 bytes, header 0x00)', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const realStakeKeyHash = hexToBytes(STAKE_VECTOR.addressHex).slice(1, 29);

    const baseAddrMatch = new Uint8Array(57);
    baseAddrMatch[0] = 0x00;
    baseAddrMatch.fill(0x11, 1, 29);
    baseAddrMatch.set(realStakeKeyHash, 29);

    it('returns true when keyHash matches the stake credential slot', () => {
      expect(keyHashMatchesAddress(pubKey, baseAddrMatch)).toBe(true);
    });

    it('returns false when neither slot matches', () => {
      const baseAddrNoMatch = new Uint8Array(57);
      baseAddrNoMatch[0] = 0x00;
      baseAddrNoMatch.fill(0x11, 1, 29);
      baseAddrNoMatch.fill(0x22, 29, 57);
      expect(keyHashMatchesAddress(pubKey, baseAddrNoMatch)).toBe(false);
    });
  });
});

describe('isDrepCredentialAddress', () => {
  const drepKeyHash = hexToBytes(DREP_VECTOR.expectedDrepAddrHex.slice(2));

  function withHeader(header: number): Uint8Array {
    const out = new Uint8Array(29);
    out[0] = header;
    out.set(drepKeyHash, 1);
    return out;
  }

  it('accepts a bare 28-byte key hash', () => {
    expect(isDrepCredentialAddress(drepKeyHash)).toBe(true);
  });

  it('accepts a 29-byte CIP-19 type-6 enterprise address (preprod header 0x60)', () => {
    expect(isDrepCredentialAddress(withHeader(0x60))).toBe(true);
  });

  it('accepts a 29-byte CIP-19 type-6 enterprise address (mainnet header 0x61)', () => {
    expect(isDrepCredentialAddress(withHeader(0x61))).toBe(true);
  });

  it('rejects the CIP-129 0x22 governance-id encoding (not a COSE address form)', () => {
    expect(isDrepCredentialAddress(hexToBytes(DREP_VECTOR.expectedDrepAddrHex))).toBe(false);
  });

  it('rejects a reward address (header 0xe0)', () => {
    expect(isDrepCredentialAddress(hexToBytes(STAKE_VECTOR.addressHex))).toBe(false);
  });

  it('rejects a 57-byte base address', () => {
    expect(isDrepCredentialAddress(new Uint8Array(57))).toBe(false);
  });

  it('rejects an empty address', () => {
    expect(isDrepCredentialAddress(new Uint8Array(0))).toBe(false);
  });

  // S4 hardening (2026-06-10 security review) — the prior implementation
  // accepted ANY byte with high nibble `0b0110` (0x60..0x6F). Spec only
  // assigns 0x60 (testnet) and 0x61 (mainnet); the remaining codepoints
  // are unallocated. We reject everything outside the explicit two.
  it('S4: rejects header 0x62 (high nibble 0x6 but unallocated low nibble)', () => {
    expect(isDrepCredentialAddress(withHeader(0x62))).toBe(false);
  });

  it('S4: rejects header 0x6F (high nibble 0x6 but unallocated low nibble)', () => {
    expect(isDrepCredentialAddress(withHeader(0x6f))).toBe(false);
  });
});

describe('drepCredentialAddress', () => {
  const keyHash = hexToBytes(DREP_VECTOR.expectedDrepAddrHex.slice(2));

  it('builds a preprod type-6 enterprise address (header 0x60) as hex', () => {
    const addr = drepCredentialAddress(keyHash, 'preprod');
    expect(addr).toBe(`60${DREP_VECTOR.expectedDrepAddrHex.slice(2)}`);
    expect(addr.length).toBe(58); // 29 bytes
  });

  it('builds a mainnet type-6 enterprise address (header 0x61) as hex', () => {
    const addr = drepCredentialAddress(keyHash, 'mainnet');
    expect(addr).toBe(`61${DREP_VECTOR.expectedDrepAddrHex.slice(2)}`);
  });

  it('produces an address accepted by isDrepCredentialAddress and bound to the pubkey', () => {
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const addrBytes = hexToBytes(drepCredentialAddress(keyHash, 'preprod'));
    expect(isDrepCredentialAddress(addrBytes)).toBe(true);
    expect(keyHashMatchesAddress(pubKey, addrBytes)).toBe(true);
  });
});

describe('ccHotKeyHashHex', () => {
  it('returns the lowercase blake2b-224 hash of the pubkey as hex (matches Koios cc_hot_hex)', () => {
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const expectedHash = DREP_VECTOR.expectedDrepAddrHex.slice(2);
    expect(ccHotKeyHashHex(pubKey)).toBe(expectedHash);
  });

  it('produces a 56-character (28-byte) lowercase hex string', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const hash = ccHotKeyHashHex(pubKey);
    expect(hash).toMatch(/^[0-9a-f]{56}$/);
  });
});

describe('cip105ToCip129', () => {
  it('converts a drep_vkh1 address to a CIP-129 drep1 address', () => {
    const knownHash = new Uint8Array(28).fill(0x42);
    const legacyAddr = encodeBech32('drep_vkh', knownHash);
    expect(legacyAddr.startsWith('drep_vkh1')).toBe(true);

    const cip129 = cip105ToCip129(legacyAddr);
    expect(cip129.startsWith('drep1')).toBe(true);

    const { data } = decodeBech32(cip129);
    expect(data[0]).toBe(0x22);
    expect(Array.from(data.slice(1))).toEqual(Array.from(knownHash));
  });

  it('round-trips: a hash re-encoded as drep_vkh1 and back to cip129 matches drepIdFromKeyHash', () => {
    const hash = new Uint8Array(28);
    hash[0] = 0xab;
    hash[27] = 0xcd;
    const legacy = encodeBech32('drep_vkh', hash);
    const result = cip105ToCip129(legacy);
    expect(result).toBe(drepIdFromKeyHash(hash));
  });

  it('drepCredentialHexFromId strips the CIP-129 header to the 28-byte hash', () => {
    const hash = new Uint8Array(28).fill(0xab);
    expect(drepCredentialHexFromId(drepIdFromKeyHash(hash))).toBe(bytesToHex(hash));
  });

  it('drepCredentialHexFromId returns the bare hash for a headerless CIP-105 id', () => {
    const hash = new Uint8Array(28).fill(0x5c);
    expect(drepCredentialHexFromId(encodeBech32('drep_vkh', hash))).toBe(bytesToHex(hash));
  });

  it('drepCredentialHexFromId returns null for an undecodable id', () => {
    expect(drepCredentialHexFromId('not-a-bech32-id')).toBeNull();
  });
});
