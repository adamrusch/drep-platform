/**
 * Regression tests for the JWT `drepId` → `registeredDrepId` rename
 * (2026-05-27).
 *
 * # The bug this guards against
 *
 * The JWT payload's `drepId` was the wallet's REGISTERED-DRep id but
 * the name implied "the DRep the wallet picks." Any new handler reading
 * `authCtx.drepId` got the wrong concept silently. We renamed it to
 * `registeredDrepId` for semantic clarity and to force any new caller
 * to think about which DRep concept they actually want.
 *
 * Tokens issued before the rename still need to validate during the
 * rotation window (≤ 7 days for `normal` sessions, ≤ 30 days for
 * `remember_me`). The compat shim accepts either field name on read
 * and prefers the new one when both are present. The legacy field can
 * be removed after 2026-06-03 (one normal-session TTL past the
 * rename's deploy).
 *
 * # What we lock in
 *
 *   1. Round-trip: issueJWT writes `registeredDrepId`; verifyJWT reads
 *      it back unchanged.
 *   2. Legacy-token parse: a manually-signed token with only the old
 *      `drepId` field still surfaces as `registeredDrepId` post-verify.
 *   3. Both fields present: the new field wins.
 *   4. No registered-DRep id at all: `registeredDrepId` is `undefined`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT } from 'jose';
import { issueJWT, verifyJWT, buildSignMessage } from './auth';

const TEST_SECRET = 'jwt-test-secret-only-for-vitest-do-not-ship';
const WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const REGISTERED_DREP = 'drep1registered';
const LEGACY_DREP = 'drep1legacytoken';

beforeAll(() => {
  // `auth.ts` reads `JWT_SECRET_NAME` first; a value without a slash is
  // used directly (not treated as a Secrets Manager ARN). That's the
  // hook for local + vitest runs.
  process.env['JWT_SECRET_NAME'] = TEST_SECRET;
});

async function manuallySignToken(
  payload: Record<string, unknown>,
  walletAddress: string,
): Promise<string> {
  const secret = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(walletAddress)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secret);
}

describe('issueJWT / verifyJWT — registeredDrepId rename', () => {
  it('round-trips registeredDrepId through issue → verify', async () => {
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal', REGISTERED_DREP);
    const verified = await verifyJWT(token);

    expect(verified.sub).toBe(WALLET);
    expect(verified.roles).toEqual(['delegator']);
    expect(verified.sessionType).toBe('normal');
    expect(verified.registeredDrepId).toBe(REGISTERED_DREP);
  });

  it('omits registeredDrepId on tokens issued without one', async () => {
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal');
    const verified = await verifyJWT(token);

    expect(verified.registeredDrepId).toBeUndefined();
  });

  it('accepts legacy tokens with the old `drepId` field and surfaces it as registeredDrepId', async () => {
    // Simulate a token issued by code from before the 2026-05-27 rename:
    // the registered-DRep id lived under the `drepId` field. Our compat
    // shim in `verifyJWT` accepts either field name during the rotation
    // window and surfaces the value as `registeredDrepId` to handlers.
    const legacyToken = await manuallySignToken(
      {
        roles: ['delegator'],
        sessionType: 'normal',
        drepId: LEGACY_DREP, // legacy field name
      },
      WALLET,
    );
    const verified = await verifyJWT(legacyToken);

    expect(verified.registeredDrepId).toBe(LEGACY_DREP);
  });

  it('prefers the new field when both `registeredDrepId` and `drepId` are present', async () => {
    // Pathological case: a token somehow carries both fields. Could
    // arise from a future code path that writes both during a longer
    // staged rollout. The new field always wins.
    const dualToken = await manuallySignToken(
      {
        roles: ['delegator'],
        sessionType: 'normal',
        registeredDrepId: REGISTERED_DREP,
        drepId: LEGACY_DREP,
      },
      WALLET,
    );
    const verified = await verifyJWT(dualToken);

    expect(verified.registeredDrepId).toBe(REGISTERED_DREP);
  });

  it('round-trips tokenVersion through issue → verify', async () => {
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal', undefined, 4);
    const verified = await verifyJWT(token);
    expect(verified.tokenVersion).toBe(4);
  });

  it('defaults tokenVersion to 0 when issued without one and on legacy tokens', async () => {
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal');
    expect((await verifyJWT(token)).tokenVersion).toBe(0);

    const legacy = await manuallySignToken({ roles: ['delegator'], sessionType: 'normal' }, WALLET);
    expect((await verifyJWT(legacy)).tokenVersion).toBe(0);
  });

  it('issued tokens do NOT carry the legacy `drepId` field on the wire', async () => {
    // Defense against accidentally re-introducing the dual-write path.
    // Decode the JWT body and assert only the new field shape is
    // present.
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal', REGISTERED_DREP);
    const [, payloadB64] = token.split('.');
    expect(payloadB64).toBeDefined();
    const payloadJson = Buffer.from(payloadB64!, 'base64url').toString('utf8');
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;

    expect(parsed['registeredDrepId']).toBe(REGISTERED_DREP);
    expect(parsed['drepId']).toBeUndefined();
  });
});

describe('buildSignMessage — stage binding', () => {
  it('embeds the stage so a challenge signed on one stage cannot verify on another', () => {
    const prev = process.env['STAGE'];
    try {
      process.env['STAGE'] = 'test';
      const onTest = buildSignMessage('nonce123', WALLET);
      process.env['STAGE'] = 'prod';
      const onProd = buildSignMessage('nonce123', WALLET);

      expect(onTest).toContain('(stage=test)');
      expect(onProd).toContain('(stage=prod)');
      expect(onTest).not.toBe(onProd);
      expect(onTest).toContain(`Wallet: ${WALLET}`);
      expect(onTest).toContain('Nonce: nonce123');
    } finally {
      if (prev === undefined) delete process.env['STAGE'];
      else process.env['STAGE'] = prev;
    }
  });
});
