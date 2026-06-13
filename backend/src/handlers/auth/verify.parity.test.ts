/**
 * Parity test for the legacy /auth/verify login cutover
 * (`feat/legacy-login-cutover`, 2026-06-11).
 *
 * # What this proves
 *
 * The /auth/verify handler used to call the LEGACY `verifyWalletSignature`
 * from `lib/auth.ts`. The cutover replaces that call with
 *   1. `verifyCip8` (the PORTED CIP-8 verifier from `lib/identity/auth/cose.ts`,
 *      the same one the on-chain login uses), followed by
 *   2. an explicit `publicKeyMatchesAddress` binding to the CLAIMED
 *      `walletAddress`, plus a defense-in-depth header-vs-claimed-address
 *      cross-check when the COSE protected header carried an `address`
 *      field.
 *
 * The LEGACY verifier already enforced both of those checks (load-bearing
 * pubkey↔claimed-address binding + defense-in-depth header cross-check).
 * The cutover is meant to preserve that contract byte-for-byte — same
 * accept/reject decision on every input, same bound identity, same
 * malformed-address handling. THIS FILE IS THE PROOF.
 *
 * For each case in the corpus, we feed the SAME `{walletAddress,
 * message, signature, key}` tuple through:
 *
 *   - the LEGACY path: `verifyWalletSignature(...)`, and
 *   - the NEW path: `verifyCip8(...)` + `publicKeyMatchesAddress(...)` +
 *     the header-vs-claimed cross-check.
 *
 * Then we assert:
 *
 *   1. The accept/reject decisions agree.
 *   2. On the accept case, the pubkey extracted by the new verifier
 *      hashes to a credential embedded in the claimed address — i.e. the
 *      "bound identity" is the SAME stake/payment credential the legacy
 *      path implicitly bound to.
 *
 * If any case here diverges, the cutover has changed the verifier's
 * behavior — STOP and re-investigate before merging. The corpus is the
 * exact set of security cases from `lib/auth.walletSignature.test.ts`
 * (which remains the standalone reference test for the legacy
 * function) PLUS a header-spoof case and a tampered-payload case.
 *
 * # Why this is a separate file from `lib/auth.walletSignature.test.ts`
 *
 * That file is the legacy-reference test — it locks in the legacy
 * verifier's behavior against the P0-1 corpus. We keep it green AS-IS so
 * it continues to act as a canary on the legacy contract. This file is a
 * PARITY test: it proves the cutover preserves that contract on the SAME
 * corpus. They serve different purposes and we want both signals in CI.
 */
import { describe, it, expect } from 'vitest';
import { encode as cborEncode } from 'cbor-x';
import { bech32 } from 'bech32';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { verifyWalletSignature } from '../../lib/auth';
import { verifyCip8 } from '../../lib/identity/auth/cose';
import {
  blake2b224,
  decodeCardanoAddress,
  publicKeyMatchesAddress,
} from '../../lib/cardanoAddress';

const MAINNET = 1;

// ---------------------------------------------------------------------------
// Fixture builders — mirror auth.walletSignature.test.ts byte-for-byte so the
// signatures we generate are identical to what that file generates.
// ---------------------------------------------------------------------------

function buildDataSignature(opts: {
  message: string;
  signingKey: CSL.PrivateKey;
  declaredAddressBytes: Uint8Array;
  omitAddressInHeader?: boolean;
}): { signature: string; key: string } {
  const payloadBytes = Buffer.from(opts.message, 'utf8');

  const headerMap = new Map<string | number, unknown>();
  headerMap.set(1, -8); // alg: EdDSA
  if (!opts.omitAddressInHeader) {
    headerMap.set('address', Buffer.from(opts.declaredAddressBytes));
  }
  const protectedBytes = Buffer.from(cborEncode(headerMap));

  const sigStructure = Buffer.from(
    cborEncode(['Signature1', protectedBytes, Buffer.alloc(0), payloadBytes]),
  );

  const signature = opts.signingKey.sign(sigStructure).to_bytes();

  const coseSign1: unknown[] = [
    protectedBytes,
    new Map(), // empty unprotected header
    payloadBytes,
    Buffer.from(signature),
  ];
  const sigHex = Buffer.from(cborEncode(coseSign1)).toString('hex');

  const coseKeyMap = new Map<number, unknown>();
  coseKeyMap.set(1, 1); // kty: OKP
  coseKeyMap.set(3, -8); // alg: EdDSA
  coseKeyMap.set(-1, 6); // crv: Ed25519
  coseKeyMap.set(-2, Buffer.from(opts.signingKey.to_public().as_bytes()));
  const keyHex = Buffer.from(cborEncode(coseKeyMap)).toString('hex');

  return { signature: sigHex, key: keyHex };
}

function freshKey(): CSL.PrivateKey {
  return CSL.PrivateKey.generate_ed25519();
}

function buildStakeAddressForKey(
  pubkey: Uint8Array,
  network = MAINNET,
): { bech32: string; bytes: Uint8Array } {
  const keyHash = CSL.Ed25519KeyHash.from_bytes(blake2b224(Buffer.from(pubkey)));
  const cred = CSL.Credential.from_keyhash(keyHash);
  const reward = CSL.RewardAddress.new(network, cred);
  const addr = reward.to_address();
  return { bech32: addr.to_bech32(), bytes: addr.to_bytes() };
}

function buildBaseAddressForKeys(
  paymentPubkey: Uint8Array,
  stakePubkey: Uint8Array,
  network = MAINNET,
): { bech32: string; bytes: Uint8Array } {
  const payHash = CSL.Ed25519KeyHash.from_bytes(blake2b224(Buffer.from(paymentPubkey)));
  const stkHash = CSL.Ed25519KeyHash.from_bytes(blake2b224(Buffer.from(stakePubkey)));
  const base = CSL.BaseAddress.new(
    network,
    CSL.Credential.from_keyhash(payHash),
    CSL.Credential.from_keyhash(stkHash),
  );
  const addr = base.to_address();
  return { bech32: addr.to_bech32(), bytes: addr.to_bytes() };
}

// ---------------------------------------------------------------------------
// The NEW verify path, extracted from `handlers/auth/verify.ts`.
//
// This MUST stay byte-identical (modulo unrelated handler machinery —
// nonce store, audit, JWT mint) to what the handler does. If the handler
// diverges, this helper must change too; the test then re-checks parity.
//
// Comment cross-ref: `verify.ts` line ~91 onwards has the canonical
// implementation. Keep this in sync.
// ---------------------------------------------------------------------------

/**
 * Run the NEW verify path on a signed message + claimed address. Returns
 * the same `{valid, reason?}` shape as the legacy `verifyWalletSignature`
 * so the parity-comparison code below can be symmetric.
 *
 * The shape is intentionally COMPATIBLE with the legacy return — that's
 * what makes the parity comparison meaningful. The handler maps `{ok:
 * false, reason}` from verifyCip8 → 401 `unauthorized(reason ?? 'Invalid
 * signature')`, same as `verifyWalletSignature` mapped `{valid:false,
 * reason}` → 401. Reason strings may differ in WORDING but the
 * accept/reject decision must agree on every case.
 */
async function newVerifyPath(
  walletAddress: string,
  message: string,
  walletSig: { signature: string; key: string },
): Promise<
  | { valid: true; pubKey: Uint8Array }
  | { valid: false; reason: string }
> {
  const cip8 = await verifyCip8({
    signatureHex: walletSig.signature,
    keyHex: walletSig.key,
    expectedPayload: message,
  });
  if (!cip8.ok || !cip8.pubKey) {
    return { valid: false, reason: cip8.reason ?? 'Invalid signature' };
  }

  let decodedClaimed: ReturnType<typeof decodeCardanoAddress>;
  try {
    decodedClaimed = decodeCardanoAddress(walletAddress);
  } catch {
    return {
      valid: false,
      reason: 'Claimed wallet address is malformed or unsupported',
    };
  }

  const pubKeyBuf = Buffer.from(cip8.pubKey);
  const matchResult = publicKeyMatchesAddress(pubKeyBuf, decodedClaimed);
  if (matchResult === 'mismatch') {
    return {
      valid: false,
      reason: 'Public key does not match the claimed wallet address',
    };
  }
  if (matchResult === 'script-credential') {
    return {
      valid: false,
      reason: 'Script-credential addresses are not supported for login',
    };
  }

  // Header vs claimed cross-check: only when verifier reports addressBound.
  if (cip8.addressBound === true && cip8.addressBytes) {
    if (!Buffer.from(cip8.addressBytes).equals(decodedClaimed.bytes)) {
      return {
        valid: false,
        reason:
          'COSE_Sign1 protected-header address does not match the claimed wallet address',
      };
    }
  }

  return { valid: true, pubKey: cip8.pubKey };
}

// ---------------------------------------------------------------------------
// Corpus definition. Each case ships ENOUGH info to build the inputs both
// paths take, so the test loops uniformly over the corpus.
//
// `bind: 'expected'` — when accepting, the verifier MUST end up with a
// pubkey whose blake2b-224 hash equals a credential in the claimed
// address. We re-derive it here and assert against the new-path's
// extracted pubkey to lock in the "bound identity is identical" half of
// parity.
// ---------------------------------------------------------------------------

interface Case {
  label: string;
  /** Expected accept/reject. Both paths MUST agree on this. */
  expect: 'accept' | 'reject';
  /** Reason fragment we expect on the LEGACY path. Used to spot-check that
   *  the legacy path is failing for the right reason, defending against a
   *  silent shape change. The NEW path's reason wording may differ. */
  legacyReasonMatch?: RegExp;
  /** Build the (walletAddress, message, walletSig) triple. */
  build(): {
    walletAddress: string;
    message: string;
    walletSig: { signature: string; key: string };
    /** When the case should accept, this is the expected bound pubkey
     *  (the hash of which must match a credential in walletAddress). */
    expectedPubKey?: Uint8Array;
  };
}

const corpus: Case[] = [
  // 1. Stake-address happy path. The bread-and-butter login case.
  {
    label: 'stake-address happy path',
    expect: 'accept',
    build() {
      const key = freshKey();
      const stake = buildStakeAddressForKey(key.to_public().as_bytes());
      const message = 'drep-platform login\nNonce: cafebabe';
      const walletSig = buildDataSignature({
        message,
        signingKey: key,
        declaredAddressBytes: stake.bytes,
      });
      return {
        walletAddress: stake.bech32,
        message,
        walletSig,
        expectedPubKey: key.to_public().as_bytes(),
      };
    },
  },
  // 2. Base address signed by stake key — wallets often hand the
  //    base/payment address while signing with the stake key. Either
  //    credential may match (legacy contract).
  {
    label: 'base-address signed by stake key',
    expect: 'accept',
    build() {
      const paymentKey = freshKey();
      const stakeKey = freshKey();
      const base = buildBaseAddressForKeys(
        paymentKey.to_public().as_bytes(),
        stakeKey.to_public().as_bytes(),
      );
      const message = 'drep-platform login\nNonce: deadbeef';
      const walletSig = buildDataSignature({
        message,
        signingKey: stakeKey,
        declaredAddressBytes: base.bytes,
      });
      return {
        walletAddress: base.bech32,
        message,
        walletSig,
        expectedPubKey: stakeKey.to_public().as_bytes(),
      };
    },
  },
  // 3. Symmetric: base address signed by the payment key — also accepted.
  {
    label: 'base-address signed by payment key',
    expect: 'accept',
    build() {
      const paymentKey = freshKey();
      const stakeKey = freshKey();
      const base = buildBaseAddressForKeys(
        paymentKey.to_public().as_bytes(),
        stakeKey.to_public().as_bytes(),
      );
      const message = 'drep-platform login\nNonce: deadbeef';
      const walletSig = buildDataSignature({
        message,
        signingKey: paymentKey,
        declaredAddressBytes: base.bytes,
      });
      return {
        walletAddress: base.bech32,
        message,
        walletSig,
        expectedPubKey: paymentKey.to_public().as_bytes(),
      };
    },
  },
  // 4. THE EXPLOIT. Signed by attackerKey, claimed for victim's address.
  //    Both paths MUST reject — this is the P0-1 auth-bypass guard.
  {
    label: 'wrong claimed address (the P0-1 exploit)',
    expect: 'reject',
    legacyReasonMatch: /does not match|claimed wallet address/i,
    build() {
      const victimKey = freshKey();
      const attackerKey = freshKey();
      const victimStake = buildStakeAddressForKey(victimKey.to_public().as_bytes());
      const message = 'drep-platform challenge\nNonce: 0000victim0000';
      const walletSig = buildDataSignature({
        message,
        signingKey: attackerKey,
        declaredAddressBytes: victimStake.bytes,
      });
      return { walletAddress: victimStake.bech32, message, walletSig };
    },
  },
  // 5. Malformed claimed address — non-bech32 garbage. Both paths reject.
  {
    label: 'malformed claimed address',
    expect: 'reject',
    legacyReasonMatch: /malformed|unsupported/i,
    build() {
      const key = freshKey();
      const stake = buildStakeAddressForKey(key.to_public().as_bytes());
      const message = 'doesn’t matter';
      const walletSig = buildDataSignature({
        message,
        signingKey: key,
        declaredAddressBytes: stake.bytes,
      });
      return { walletAddress: 'not-a-real-address', message, walletSig };
    },
  },
  // 6. Pointer-address header (0x4) — deprecated address shape; both
  //    decoders reject.
  {
    label: 'pointer-address (deprecated header type)',
    expect: 'reject',
    legacyReasonMatch: /malformed|unsupported/i,
    build() {
      const key = freshKey();
      const stake = buildStakeAddressForKey(key.to_public().as_bytes());
      const message = 'irrelevant';
      const walletSig = buildDataSignature({
        message,
        signingKey: key,
        declaredAddressBytes: stake.bytes,
      });
      const pointerBytes = Buffer.concat([
        Buffer.from([0x41]),
        Buffer.alloc(28, 0xaa),
        Buffer.from([0x01, 0x02, 0x03]),
      ]);
      const words = bech32.toWords(pointerBytes);
      const pointerAddrBech32 = bech32.encode('addr', words, 1023);
      return { walletAddress: pointerAddrBech32, message, walletSig };
    },
  },
  // 7. Script-credential stake address. The key's hash numerically
  //    matches but the credential type is `script` → both paths reject.
  {
    label: 'script-credential stake address',
    expect: 'reject',
    legacyReasonMatch: /script-credential/i,
    build() {
      const key = freshKey();
      const keyHash = blake2b224(Buffer.from(key.to_public().as_bytes()));
      const scriptStakeBytes = Buffer.concat([Buffer.from([0xf1]), keyHash]);
      const scriptStakeBech32 = CSL.Address.from_bytes(scriptStakeBytes).to_bech32();
      const message = 'login challenge\nNonce: scripted';
      const walletSig = buildDataSignature({
        message,
        signingKey: key,
        declaredAddressBytes: scriptStakeBytes,
      });
      return { walletAddress: scriptStakeBech32, message, walletSig };
    },
  },
  // 8. Older-wallet shape — protected header omits the `address` field.
  //    Both paths accept, relying on the pubkey↔claimed-address binding.
  {
    label: 'missing protected-header address (older-wallet shape)',
    expect: 'accept',
    build() {
      const key = freshKey();
      const stake = buildStakeAddressForKey(key.to_public().as_bytes());
      const message = 'header-omit test\nNonce: 1234';
      const walletSig = buildDataSignature({
        message,
        signingKey: key,
        declaredAddressBytes: stake.bytes,
        omitAddressInHeader: true,
      });
      return {
        walletAddress: stake.bech32,
        message,
        walletSig,
        expectedPubKey: key.to_public().as_bytes(),
      };
    },
  },
  // 9. Protected-header address spoof. Signed for addrB, claimed addrA;
  //    both authorize the same stake key so credential binding passes.
  //    The header cross-check fires — both paths reject.
  {
    label: 'protected-header address conflicts with claimed address',
    expect: 'reject',
    legacyReasonMatch: /protected-header address/i,
    build() {
      const ourKey = freshKey();
      const otherPaymentA = freshKey();
      const otherPaymentB = freshKey();
      const addrA = buildBaseAddressForKeys(
        otherPaymentA.to_public().as_bytes(),
        ourKey.to_public().as_bytes(),
      );
      const addrB = buildBaseAddressForKeys(
        otherPaymentB.to_public().as_bytes(),
        ourKey.to_public().as_bytes(),
      );
      const message = 'spoof-header test\nNonce: 9999';
      const walletSig = buildDataSignature({
        message,
        signingKey: ourKey,
        declaredAddressBytes: addrB.bytes, // header says addrB
      });
      // Claim addrA. Credential binding passes (our key matches addrA's
      // stake cred). Header cross-check rejects.
      return { walletAddress: addrA.bech32, message, walletSig };
    },
  },
  // 10. Payload tamper — server expected one message, wallet signed
  //     something else. Both paths reject at the payload-equality step.
  {
    label: 'payload tamper (server expected != wallet signed)',
    expect: 'reject',
    legacyReasonMatch: /payload/i,
    build() {
      const key = freshKey();
      const stake = buildStakeAddressForKey(key.to_public().as_bytes());
      const walletSig = buildDataSignature({
        message: 'wallet signed THIS',
        signingKey: key,
        declaredAddressBytes: stake.bytes,
      });
      // Server checks against a DIFFERENT message.
      return {
        walletAddress: stake.bech32,
        message: 'but the server expected something different',
        walletSig,
      };
    },
  },
  // 11. Tampered signature byte — flipped bit in the Ed25519 signature.
  //     Both paths reject at the cryptographic verify step.
  {
    label: 'tampered Ed25519 signature byte',
    expect: 'reject',
    legacyReasonMatch: /Ed25519|signature|verification/i,
    build() {
      const key = freshKey();
      const stake = buildStakeAddressForKey(key.to_public().as_bytes());
      const message = 'test message';
      const walletSig = buildDataSignature({
        message,
        signingKey: key,
        declaredAddressBytes: stake.bytes,
      });
      // Flip a byte deep inside the CBOR-encoded sig.
      const sigBuf = Buffer.from(walletSig.signature, 'hex');
      sigBuf[sigBuf.length - 5] = (sigBuf[sigBuf.length - 5]! ^ 0x01) & 0xff;
      return {
        walletAddress: stake.bech32,
        message,
        walletSig: { ...walletSig, signature: sigBuf.toString('hex') },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// The parity assertions.
// ---------------------------------------------------------------------------

describe('parity: legacy verifyWalletSignature ≡ new verifyCip8 + claimed-address binding', () => {
  for (const c of corpus) {
    it(`agrees on "${c.label}" (expected: ${c.expect})`, async () => {
      const { walletAddress, message, walletSig, expectedPubKey } = c.build();

      // ---- LEGACY path ----
      const legacy = verifyWalletSignature(walletAddress, message, walletSig);
      // ---- NEW path ----
      const next = await newVerifyPath(walletAddress, message, walletSig);

      // 1. Accept/reject decisions must agree. This is the load-bearing
      //    parity assertion — every case in the corpus is here primarily
      //    to lock in this property.
      expect(legacy.valid).toBe(next.valid);

      if (c.expect === 'accept') {
        // Both paths accepted; the bound identity must be SAME — the
        // new path's extracted pubkey must hash to a credential in the
        // claimed address (and to the expected pubkey we built the
        // address from). The legacy path didn't surface a pubkey but it
        // also bound to the SAME credential by construction (it's the
        // only key whose hash matches), so this assertion locks in the
        // "bound identity is identical" half of parity.
        expect(legacy.valid).toBe(true);
        expect(next.valid).toBe(true);
        if (next.valid && expectedPubKey) {
          expect(Buffer.from(next.pubKey).equals(Buffer.from(expectedPubKey))).toBe(true);
        }
      } else {
        // Both paths rejected. Spot-check the LEGACY reason matches the
        // expected fragment so a silent shape change in the legacy
        // verifier (e.g. a refactor of `verifyCoseSign1Core`) trips this
        // file too — this file is the parity canary, not the legacy
        // canary, but a regression there will fan out here as a
        // mismatched-reason failure that gets noticed.
        expect(legacy.valid).toBe(false);
        expect(next.valid).toBe(false);
        if (c.legacyReasonMatch && !legacy.valid) {
          expect(legacy.reason).toMatch(c.legacyReasonMatch);
        }
      }
    });
  }
});
