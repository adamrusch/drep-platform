/**
 * Regression tests for `extractAuthContext` — specifically the
 * 2026-05-27 rename of the authorizer-context field
 * `drepId` → `registeredDrepId` and the legacy-fallback shim.
 *
 * # Why a fallback exists
 *
 * The JWT authorizer Lambda and the downstream handler Lambdas
 * redeploy independently. During the rollout window the authorizer
 * may still emit the old `drepId` field while a handler has already
 * been redeployed to read `registeredDrepId`. The legacy fallback
 * accepts either field shape and prefers the new one. It can be
 * removed after 2026-06-03 (one normal-session JWT TTL past the
 * rename's rollout); by then the authorizer Lambda is also guaranteed
 * to emit only the new shape.
 */

import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { extractAuthContext } from './role-guard';

const WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const NEW_DREP = 'drep1newfield';
const LEGACY_DREP = 'drep1legacyfield';

function buildEvent(ctx: Record<string, string>): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      authorizer: { lambda: ctx },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer['requestContext'],
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('extractAuthContext — registeredDrepId rename compat', () => {
  it('reads the new `registeredDrepId` field from the authorizer context', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        registeredDrepId: NEW_DREP,
      }),
    );

    expect(ctx.walletAddress).toBe(WALLET);
    expect(ctx.roles).toEqual(['delegator']);
    expect(ctx.registeredDrepId).toBe(NEW_DREP);
  });

  it('falls back to the legacy `drepId` authorizer-context field when the new one is absent', () => {
    // Simulates the rollout window where the authorizer Lambda is
    // still on the old code and emits `drepId` instead of
    // `registeredDrepId`. The downstream handler must still see the
    // registered-DRep id.
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        drepId: LEGACY_DREP,
      }),
    );

    expect(ctx.registeredDrepId).toBe(LEGACY_DREP);
  });

  it('prefers the new field when both are present', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        registeredDrepId: NEW_DREP,
        drepId: LEGACY_DREP,
      }),
    );

    expect(ctx.registeredDrepId).toBe(NEW_DREP);
  });

  it('returns undefined when neither field is present', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
      }),
    );

    expect(ctx.registeredDrepId).toBeUndefined();
  });
});
