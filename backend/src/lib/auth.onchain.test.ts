/**
 * Tests for the Sprint 1 additive JWT claims (`onChainRoles`, `jti`) and
 * the per-stage on-chain cookie helpers.
 *
 * # What we lock in
 *
 *   1. `issueJWT` writes `onChainRoles` only when at least one was passed
 *      — legacy tokens (no extra arg) keep their exact prior shape.
 *   2. `verifyJWT` round-trips `onChainRoles` and `jti` when present and
 *      defaults `onChainRoles` to `[]` on legacy tokens.
 *   3. The `OnChainRole` parser filters out unknown role strings so a
 *      forged or future-version token can't smuggle in a bogus role.
 *   4. On-chain cookie naming is per-stage so a prod cookie scoped to
 *      `.drep.tools` can't shadow a stage cookie on a subdomain.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT } from 'jose';
import {
  issueJWT,
  verifyJWT,
  onChainCookieName,
  extractOnChainTokenFromCookie,
  buildOnChainSetCookieHeader,
  buildOnChainClearCookieHeader,
} from './auth';

const TEST_SECRET = 'jwt-test-secret-only-for-vitest-do-not-ship';
const WALLET = 'drep1test_onchain_drep';

beforeAll(() => {
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

describe('issueJWT — onChainRoles + jti are additive', () => {
  it('omits onChainRoles + jti when no extra arg is passed (legacy shape)', async () => {
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal');
    const [, payloadB64] = token.split('.');
    const parsed = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(parsed['onChainRoles']).toBeUndefined();
    expect(parsed['jti']).toBeUndefined();
  });

  it('omits onChainRoles when empty array passed (no wire bytes wasted)', async () => {
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal', undefined, 0, {
      onChainRoles: [],
    });
    const [, payloadB64] = token.split('.');
    const parsed = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(parsed['onChainRoles']).toBeUndefined();
  });

  it('writes onChainRoles + jti when supplied', async () => {
    const { token } = await issueJWT(WALLET, ['guest'], 'normal', undefined, 0, {
      onChainRoles: ['spo'],
      jti: '01HABCDEF',
    });
    const [, payloadB64] = token.split('.');
    const parsed = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(parsed['onChainRoles']).toEqual(['spo']);
    expect(parsed['jti']).toBe('01HABCDEF');
  });
});

describe('verifyJWT — onChainRoles + jti round-trip', () => {
  it('round-trips onChainRoles + jti', async () => {
    const { token } = await issueJWT(WALLET, ['guest'], 'normal', undefined, 0, {
      onChainRoles: ['cc'],
      jti: '01HJTI',
    });
    const verified = await verifyJWT(token);
    expect(verified.onChainRoles).toEqual(['cc']);
    expect(verified.jti).toBe('01HJTI');
  });

  it('defaults onChainRoles to [] when absent (legacy tokens)', async () => {
    const { token } = await issueJWT(WALLET, ['delegator'], 'normal');
    const verified = await verifyJWT(token);
    expect(verified.onChainRoles).toEqual([]);
    expect(verified.jti).toBeUndefined();
  });

  it('filters out unknown role strings — never trust the wire', async () => {
    const token = await manuallySignToken(
      {
        roles: ['delegator'],
        sessionType: 'normal',
        // Mix one valid + two invalid roles. The valid one survives, the
        // invalid ones are dropped without error so a future jose update
        // that ships a new role name doesn't break older verifiers.
        onChainRoles: ['drep', 'super_admin', null],
      },
      WALLET,
    );
    const verified = await verifyJWT(token);
    expect(verified.onChainRoles).toEqual(['drep']);
  });

  it('treats a non-array onChainRoles claim as []', async () => {
    const token = await manuallySignToken(
      {
        roles: ['delegator'],
        sessionType: 'normal',
        onChainRoles: 'this is not an array',
      },
      WALLET,
    );
    const verified = await verifyJWT(token);
    expect(verified.onChainRoles).toEqual([]);
  });
});

describe('on-chain cookie helpers', () => {
  it('per-stage cookie name — prod gets the unsuffixed name', () => {
    const prev = process.env['STAGE'];
    try {
      process.env['STAGE'] = 'prod';
      expect(onChainCookieName()).toBe('access_token_onchain');
      process.env['STAGE'] = 'test';
      expect(onChainCookieName()).toBe('access_token_onchain_test');
      process.env['STAGE'] = 'dev';
      expect(onChainCookieName()).toBe('access_token_onchain_dev');
    } finally {
      if (prev === undefined) delete process.env['STAGE'];
      else process.env['STAGE'] = prev;
    }
  });

  it('extracts the on-chain cookie from a multi-cookie header', () => {
    const prev = process.env['STAGE'];
    try {
      process.env['STAGE'] = 'test';
      const cookieHeader =
        'foo=bar; access_token_test=legacy.jwt.here; access_token_onchain_test=onchain.jwt.here; other=quux';
      expect(extractOnChainTokenFromCookie(cookieHeader)).toBe('onchain.jwt.here');
      expect(extractOnChainTokenFromCookie(undefined)).toBeNull();
      expect(extractOnChainTokenFromCookie('no_matching_cookie=x')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env['STAGE'];
      else process.env['STAGE'] = prev;
    }
  });

  it('builds Set-Cookie with HttpOnly + Secure + SameSite=Strict', () => {
    const prev = process.env['STAGE'];
    try {
      process.env['STAGE'] = 'test';
      const header = buildOnChainSetCookieHeader('thetoken', 'normal');
      expect(header).toContain('access_token_onchain_test=thetoken');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('Secure');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain('Max-Age=');
    } finally {
      if (prev === undefined) delete process.env['STAGE'];
      else process.env['STAGE'] = prev;
    }
  });

  it('builds a Max-Age=0 clear header for logout', () => {
    const prev = process.env['STAGE'];
    try {
      process.env['STAGE'] = 'test';
      const header = buildOnChainClearCookieHeader();
      expect(header).toContain('access_token_onchain_test=');
      expect(header).toContain('Max-Age=0');
      expect(header).toContain('HttpOnly');
    } finally {
      if (prev === undefined) delete process.env['STAGE'];
      else process.env['STAGE'] = prev;
    }
  });
});
