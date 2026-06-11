/**
 * Security-critical regression tests for `verifyWalletSignature` — the
 * P0-1 auth-bypass fix (2026-05-28 audit).
 *
 * # The exact attack these guard against
 *
 * The original implementation (before this PR) verified:
 *   1. The COSE_Sign1 payload matches the expected challenge message.
 *   2. The Ed25519 signature is valid for the COSE_Key pubkey.
 *
 * What it did NOT verify:
 *   3. That the COSE_Key pubkey is one that the claimed `walletAddress`
 *      actually authorises (i.e. its blake2b-224 hash equals a credential
 *      embedded in the address).
 *
 * Outcome: an attacker who could observe a victim's wallet address could
 * sign the victim-addressed challenge with their OWN keypair and present
 * the resulting `{signature, key}` blob with the victim's address as
 * `walletAddress`. The server accepted it — account takeover.
 *
 * The "mismatch rejected" test below is the EXACT exploit reduced to its
 * essence. If that test ever regresses, the bug is back. Treat it as a
 * canary for the entire credential-binding subsystem.
 *
 * # What we cover
 *
 *   1. **Happy path — stake address.** A real CIP-30-shaped DataSignature
 *      where the signing key's blake2b-224 hash matches the stake
 *      credential embedded in the claimed `stake1...` address. Asserts
 *      `valid: true`.
 *   2. **Happy path — base address.** Same shape but `addr1...`; the
 *      stake credential in the base address matches. Asserts `valid: true`.
 *   3. **Mismatch rejected (the exploit).** A real DataSignature signed by
 *      key B, claimed for an address whose only credential is key A's hash
 *      (A ≠ B). Asserts `valid: false` with reason mentioning
 *      "match...address".
 *   4. **Garbage address rejected.** Non-bech32 nonsense → reject, no
 *      throw.
 *   5. **Pointer address rejected.** Header type 0x4 (deprecated pointer
 *      addresses) → reject.
 *   6. **Script-credential address rejected.** A stake address built from
 *      a script credential — even with a key that hashes to the same 28
 *      bytes — must be rejected.
 *
 * # Mocking strategy
 *
 * We use `@emurgo/cardano-serialization-lib-nodejs` (already a backend
 * dep) to (a) generate an Ed25519 keypair, (b) derive its bech32 stake
 * address, and (c) sign the canonical challenge message into a real CIP-8
 * COSE_Sign1 vector. The COSE_Sign1 / COSE_Key encoding is hand-rolled
 * here — CIP-30 wallets do exactly this; the spec is unambiguous so
 * reproducing it in test code is safe.
 */
import { describe, it, expect } from 'vitest';
import { encode as cborEncode } from 'cbor-x';
import { bech32 } from 'bech32';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { verifyWalletSignature } from './auth';
import { blake2b224 } from './cardanoAddress';

const MAINNET = 1;
const _TESTNET = 0;

/**
 * Build a CIP-30 DataSignature for the given message, signing key, and
 * declared signing address. Returns the same `{signature, key}` shape
 * that `wallet.signData(addressHex, payload)` returns in the browser.
 *
 * Faithful to CIP-8 / CIP-30:
 *   - `signature` is CBOR(COSE_Sign1) where COSE_Sign1 = [
 *       protected_bstr,   // CBOR( { 1: -8, "address": address_bytes } )
 *       {},               // unprotected header (empty map)
 *       payload_bstr,     // raw UTF-8 of the message
 *       sig_bstr          // Ed25519 sig over Sig_Structure
 *     ]
 *   - The Sig_Structure being signed is:
 *       [ "Signature1", protected_bstr, h''(external_aad), payload_bstr ]
 *   - `key` is CBOR(COSE_Key) = { 1: 1 (OKP), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: pubkey }
 *
 * # Why we DON'T use a high-level lib for this
 *
 * `@emurgo/cardano-message-signing-nodejs` exists but isn't already
 * pulled in; introducing it just for tests would be a new prod-time
 * transitive dependency surface for no benefit. The CIP-8 encoding is
 * a handful of bytes and reproducing it here is the same code path the
 * wallet vendors implement.
 */
function buildDataSignature(opts: {
  message: string;
  signingKey: CSL.PrivateKey;
  declaredAddressBytes: Uint8Array;
  /** When true, OMIT the `address` field from the protected header.
   *  Models the small minority of older wallet builds that don't include
   *  it; the server-side credential binding should still accept the
   *  signature. */
  omitAddressInHeader?: boolean;
}): { signature: string; key: string } {
  const payloadBytes = Buffer.from(opts.message, 'utf8');

  // Protected header map. CIP-30 uses string key "address" with the raw
  // address bytes as the value, plus the standard COSE alg label
  // (`1` = alg, `-8` = EdDSA).
  const headerMap = new Map<string | number, unknown>();
  headerMap.set(1, -8); // alg: EdDSA
  if (!opts.omitAddressInHeader) {
    headerMap.set('address', Buffer.from(opts.declaredAddressBytes));
  }
  const protectedBytes = Buffer.from(cborEncode(headerMap));

  // Sig_Structure = ["Signature1", protected_bstr, external_aad(empty), payload_bstr]
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

  // COSE_Key for the public key.
  const coseKeyMap = new Map<number, unknown>();
  coseKeyMap.set(1, 1); // kty: OKP
  coseKeyMap.set(3, -8); // alg: EdDSA
  coseKeyMap.set(-1, 6); // crv: Ed25519
  coseKeyMap.set(-2, Buffer.from(opts.signingKey.to_public().as_bytes()));
  const keyHex = Buffer.from(cborEncode(coseKeyMap)).toString('hex');

  return { signature: sigHex, key: keyHex };
}

/** Generate a fresh Ed25519 keypair via CSL. */
function freshKey(): CSL.PrivateKey {
  return CSL.PrivateKey.generate_ed25519();
}

/** Build a stake (reward) address whose credential is the blake2b-224
 *  hash of `pubkey`. Returns `{bech32, bytes}`. */
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

/** Build a base address whose stake credential matches `stakePubkey` and
 *  whose payment credential matches `paymentPubkey`. */
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

describe('verifyWalletSignature — pubkey/address credential binding (P0-1)', () => {
  it('accepts a valid signature on a stake address whose credential matches the signing key', () => {
    const key = freshKey();
    const stake = buildStakeAddressForKey(key.to_public().as_bytes());
    const msg = 'drep-platform wants you to sign in: …\nNonce: cafebabe\n';

    const sig = buildDataSignature({
      message: msg,
      signingKey: key,
      declaredAddressBytes: stake.bytes,
    });

    const result = verifyWalletSignature(stake.bech32, msg, sig);
    expect(result).toEqual({ valid: true });
  });

  it('accepts a valid signature on a base address whose stake credential matches the signing key', () => {
    // Wallets typically sign with the STAKE key for login challenges and
    // hand the base (`addr1...`) address as `walletAddress`. Our matcher
    // accepts either credential (payment OR stake) so this works.
    const paymentKey = freshKey();
    const stakeKey = freshKey();
    const base = buildBaseAddressForKeys(
      paymentKey.to_public().as_bytes(),
      stakeKey.to_public().as_bytes(),
    );
    const msg = 'login challenge for base address\nNonce: deadbeef';

    const sig = buildDataSignature({
      message: msg,
      signingKey: stakeKey, // signed by the STAKE key
      declaredAddressBytes: base.bytes,
    });

    const result = verifyWalletSignature(base.bech32, msg, sig);
    expect(result).toEqual({ valid: true });
  });

  it('accepts a valid signature on a base address whose payment credential matches the signing key', () => {
    // Symmetric: signed by the payment key instead. Same address, still
    // valid — either credential slot can match.
    const paymentKey = freshKey();
    const stakeKey = freshKey();
    const base = buildBaseAddressForKeys(
      paymentKey.to_public().as_bytes(),
      stakeKey.to_public().as_bytes(),
    );
    const msg = 'login challenge for base address\nNonce: deadbeef';

    const sig = buildDataSignature({
      message: msg,
      signingKey: paymentKey,
      declaredAddressBytes: base.bytes,
    });

    const result = verifyWalletSignature(base.bech32, msg, sig);
    expect(result).toEqual({ valid: true });
  });

  it('REJECTS the exact exploit: signature by key B claimed for an address built from key A (A≠B)', () => {
    // The whole point of P0-1. Without the credential binding, this
    // returns `{valid: true}` and the attacker gets a session for the
    // victim. MUST fail closed.
    const victimKey = freshKey();
    const attackerKey = freshKey();

    const victimStake = buildStakeAddressForKey(victimKey.to_public().as_bytes());
    const msg = 'drep-platform challenge\nNonce: 0000victim0000';

    // Attacker signs the victim-addressed challenge with their OWN key.
    // Note: they ALSO set the protected-header address to the victim's
    // address (which the server will cross-check) — but credential
    // binding kills the request before that comes into play.
    const exploitSig = buildDataSignature({
      message: msg,
      signingKey: attackerKey,
      declaredAddressBytes: victimStake.bytes,
    });

    const result = verifyWalletSignature(victimStake.bech32, msg, exploitSig);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Public key does not match');
  });

  it('rejects a malformed (non-bech32) address with `valid:false`, never throws', () => {
    const key = freshKey();
    const stake = buildStakeAddressForKey(key.to_public().as_bytes());
    const msg = 'doesn’t matter';
    const sig = buildDataSignature({
      message: msg,
      signingKey: key,
      declaredAddressBytes: stake.bytes,
    });

    const result = verifyWalletSignature('not-a-real-address', msg, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed|unsupported/i);
  });

  it('rejects a pointer-address header (0x4) with `valid:false`, never throws', () => {
    // Manually construct a pointer-address-shaped bech32 string. Pointer
    // addresses (header high nibble = 0x4 or 0x5) are deprecated and our
    // decoder rejects them outright. We bypass CSL's stricter validator
    // here because CSL won't even parse a malformed pointer — but our
    // job is to reject this BEFORE handing to anyone, and the raw bytes
    // are what an attacker would actually craft.
    const key = freshKey();
    const stake = buildStakeAddressForKey(key.to_public().as_bytes());
    const msg = 'irrelevant';
    const sig = buildDataSignature({
      message: msg,
      signingKey: key,
      declaredAddressBytes: stake.bytes,
    });

    // 0x41 = pointer header, mainnet. 1 header + 28 credential + a few
    // bytes of "pointer". Total irrelevant — our decoder rejects on
    // header type alone (high nibble 0x4 isn't in the accepted set).
    const pointerBytes = Buffer.concat([
      Buffer.from([0x41]),
      Buffer.alloc(28, 0xaa),
      Buffer.from([0x01, 0x02, 0x03]),
    ]);
    const words = bech32.toWords(pointerBytes);
    const pointerAddrBech32 = bech32.encode('addr', words, 1023);

    const result = verifyWalletSignature(pointerAddrBech32, msg, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed|unsupported/i);
  });

  it('rejects a script-credential stake address even when the key hashes to the same 28 bytes', () => {
    // Build a stake address with header type 0xf (script-credential
    // stake) but use a KEY hash as the credential bytes. The address
    // decoder reads the header as "script", so even though the bytes
    // numerically match what our pubkey hashes to, the verifier reports
    // `script-credential` and rejects.
    const key = freshKey();
    const keyHash = blake2b224(Buffer.from(key.to_public().as_bytes()));

    // Manually compose: 0xf1 header (stake script, mainnet) + 28-byte
    // credential bytes.
    const scriptStakeBytes = Buffer.concat([Buffer.from([0xf1]), keyHash]);
    const scriptStakeBech32 = CSL.Address.from_bytes(scriptStakeBytes).to_bech32();

    const msg = 'login challenge\nNonce: scripted';
    const sig = buildDataSignature({
      message: msg,
      signingKey: key,
      declaredAddressBytes: scriptStakeBytes,
    });

    const result = verifyWalletSignature(scriptStakeBech32, msg, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/script-credential/i);
  });

  it('accepts a valid signature when the protected-header omits the `address` field (older-wallet shape)', () => {
    // Spec says SHOULD include; some wallets don't. Credential binding
    // is sufficient on its own — the optional header check is only
    // defense-in-depth and MUST NOT lock these users out.
    const key = freshKey();
    const stake = buildStakeAddressForKey(key.to_public().as_bytes());
    const msg = 'header-omit test\nNonce: 1234';
    const sig = buildDataSignature({
      message: msg,
      signingKey: key,
      declaredAddressBytes: stake.bytes,
      omitAddressInHeader: true,
    });

    const result = verifyWalletSignature(stake.bech32, msg, sig);
    expect(result).toEqual({ valid: true });
  });

  it('REJECTS when the protected-header address conflicts with the claimed walletAddress', () => {
    // Pathological case: somehow the attacker controls a key whose hash
    // matches one credential in the address (so step-5 passes) BUT they
    // put a different address in the protected header. The defense-in-
    // depth check fires.
    //
    // We synthesize this by signing for address A, then telling the
    // verifier the address is also A while putting B in the header. The
    // only way to construct this naturally is with two addresses that
    // both authorise the SAME key — easy with a base address: build it
    // so its STAKE cred = our key hash, then build a DIFFERENT base
    // address with that same stake cred but a different payment cred.
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

    const msg = 'spoof-header test\nNonce: 9999';
    const sig = buildDataSignature({
      message: msg,
      signingKey: ourKey,
      declaredAddressBytes: addrB.bytes, // header says addrB
    });

    // Claim addrA. Credential binding passes (our key matches addrA's
    // stake cred). Header cross-check sees addrB and rejects.
    const result = verifyWalletSignature(addrA.bech32, msg, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/protected-header address/i);
  });
});

describe('verifyWalletSignature — existing pre-binding invariants still hold', () => {
  it('rejects a payload that doesn’t match the expected message', () => {
    const key = freshKey();
    const stake = buildStakeAddressForKey(key.to_public().as_bytes());
    const sig = buildDataSignature({
      message: 'the wallet signed this',
      signingKey: key,
      declaredAddressBytes: stake.bytes,
    });
    const result = verifyWalletSignature(
      stake.bech32,
      'but the server expected this different message',
      sig,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/payload/i);
  });

  it('rejects a tampered signature byte', () => {
    const key = freshKey();
    const stake = buildStakeAddressForKey(key.to_public().as_bytes());
    const msg = 'test message';
    const sig = buildDataSignature({
      message: msg,
      signingKey: key,
      declaredAddressBytes: stake.bytes,
    });
    // Flip a byte in the middle of the signature hex.
    const sigBuf = Buffer.from(sig.signature, 'hex');
    sigBuf[sigBuf.length - 5] = (sigBuf[sigBuf.length - 5]! ^ 0x01) & 0xff;
    const tamperedSig = { ...sig, signature: sigBuf.toString('hex') };

    const result = verifyWalletSignature(stake.bech32, msg, tamperedSig);
    expect(result.valid).toBe(false);
  });
});
