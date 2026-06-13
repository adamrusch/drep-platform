/**
 * Tests for the Sprint 3 daily on-chain role revalidation cron.
 *
 * # What we lock in
 *
 *   1. **Still-valid identity keeps its sessions.** A DRep / CC /
 *      proposer whose role check returns positive from Koios → cron
 *      makes NO revoke call. (`identitiesStillValid` increments.)
 *
 *   2. **Now-deregistered identity gets revoked.** A DRep whose
 *      `resolveDRep` returns `{isDrep: false}` → cron calls
 *      `revokeAllSessionsForUser` exactly once for that identity.
 *
 *   3. **Koios error leaves sessions intact.** A DRep whose
 *      `koios.drepInfo()` throws → cron skips the identity; NO
 *      revoke call; `identitiesUpstreamFailures` counter increments.
 *
 *   4. **Pre-Sprint-3 records (no role) are skipped.** A
 *      `session_index` row with no `onChainRole` is counted under
 *      `identitiesSkippedNoRole` and never revoked — we can't pick
 *      the right resolver without knowing the role.
 *
 *   5. **Enumeration failure does NOT revoke.** A Scan-throws path
 *      returns an empty result and writes nothing — guards the
 *      "Koios outage = mass revoke" failure mode.
 *
 *   6. **Empty CC roster is treated as upstream-failure, not
 *      definitive revoke.** A `committeeInfo()` that returns `[]`
 *      reads as a likely brownout, not "no CC members" — we skip
 *      rather than risk mass-revoking every CC session.
 *
 *   7. **Strict adapter propagates Koios errors.** Importantly,
 *      the cron uses a STRICT adapter (NOT the verify-path
 *      `buildKoiosAdapter` which swallows errors). The integration
 *      test below proves that a thrown Koios helper surfaces all the
 *      way up to the decision logic, where it correctly maps to
 *      upstream-failure — not to a `null` reading that would be
 *      indistinguishable from a definitive deregistration.
 */
import { describe, it, expect, vi } from 'vitest';

// The strict adapter wraps the koios.ts helpers; mock those so the
// integration test for the strict adapter doesn't hit the network.
vi.mock('../lib/koios', async () => {
  return {
    fetchDRepInfoBatch: vi.fn(async () => []),
    listProposals: vi.fn(async () => []),
    getCommitteeMembers: vi.fn(async () => []),
    listAllPools: vi.fn(async () => []),
    // S4 hardening — the strict adapter invalidates the committee
    // cache before each `committeeInfo` call so the cron always sees
    // a fresh roster. The mock is a no-op here; we just need the
    // symbol to exist so the strict adapter can import it.
    invalidateCommitteeCache: vi.fn(),
    // KoiosError is also exported by the live module; preserve the
    // throwable shape for any test that throws it explicitly.
    KoiosError: class KoiosError extends Error {
      public readonly status: number | undefined;
      public readonly endpoint: string;
      constructor(endpoint: string, message: string, status?: number) {
        super(`[Koios ${endpoint}] ${message}`);
        this.name = 'KoiosError';
        this.endpoint = endpoint;
        this.status = status;
      }
    },
  };
});

import { runRevalidateOnChainRoles, decideForIdentity } from './revalidate-onchain-roles';
import type { ActiveSessionIndex } from '../lib/sessionRevocation';
import type { KoiosClient } from '../lib/identity/auth/koios';
import * as koiosHelpers from '../lib/koios';

function fakeKoios(overrides: Partial<KoiosClient> = {}): KoiosClient {
  return {
    drepInfo: async () => null,
    proposalsByReturnAddress: async () => [],
    poolCalidusKey: async () => null,
    committeeInfo: async () => [],
    poolStatus: async () => null,
    poolCalidusKeyByPool: async () => null,
    ...overrides,
  };
}

describe('decideForIdentity — pure decision logic', () => {
  it('drep with active registration → still-valid', async () => {
    const koios = fakeKoios({
      drepInfo: async (_drepId: string) => ({
        drep_id: 'drep1aaaa',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
      }),
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'drep1aaaa',
      onChainRole: 'drep',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('still-valid');
  });

  it('drep that resolveDRep says is no longer registered → revoke', async () => {
    const koios = fakeKoios({
      // Koios returned null — drep_info found no row for this id (the
      // common "deregistered" signature).
      drepInfo: async () => null,
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'drep1zzzz_deregistered',
      onChainRole: 'drep',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
    if (decision.action === 'revoke') {
      expect(decision.reason).toContain('drep no longer registered');
    }
  });

  it('drep whose koios.drepInfo() throws → upstream-failure (sessions kept)', async () => {
    const koios = fakeKoios({
      drepInfo: async () => {
        throw new Error('Koios 503');
      },
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'drep1xxx_brownout',
      onChainRole: 'drep',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('upstream-failure');
  });

  it('CC member found in committee_info → still-valid', async () => {
    const koios = fakeKoios({
      committeeInfo: async () => [
        {
          status: 'authorized',
          cc_hot_id: 'cc_hot1aaa',
          cc_cold_id: 'cc_cold1aaa',
          cc_hot_hex: 'aaaaaa',
          cc_cold_hex: null,
          expiration_epoch: null,
          cc_hot_has_script: false,
          cc_cold_has_script: false,
        },
      ],
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'cc_cold1aaa',
      onChainRole: 'cc',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('still-valid');
  });

  it('CC member missing from non-empty committee_info → revoke', async () => {
    const koios = fakeKoios({
      committeeInfo: async () => [
        // Someone ELSE is authorized; our identity is not.
        {
          status: 'authorized',
          cc_hot_id: 'cc_hot1someone_else',
          cc_cold_id: 'cc_cold1someone_else',
          cc_hot_hex: 'bbbbbb',
          cc_cold_hex: null,
          expiration_epoch: null,
          cc_hot_has_script: false,
          cc_cold_has_script: false,
        },
      ],
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'cc_cold1revoked',
      onChainRole: 'cc',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
  });

  it('CC member with empty committee_info → upstream-failure (NOT revoke)', async () => {
    // Critical fail-safe: an empty committee from Koios is more likely a
    // brownout than the genuine "no CC members exist" end-state.
    // Treating it as definitive revoke would mass-wipe every CC session.
    const koios = fakeKoios({
      committeeInfo: async () => [],
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'cc_cold1aaa',
      onChainRole: 'cc',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('upstream-failure');
  });

  it('proposer with matching return_address → still-valid', async () => {
    const koios = fakeKoios({
      proposalsByReturnAddress: async (sa: string) => [
        { proposal_id: 'gov_action_1', return_address: sa, proposal_type: 'InfoAction' },
      ],
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'stake1aaa',
      onChainRole: 'proposer',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('still-valid');
  });

  it('proposer with no remaining proposals → revoke', async () => {
    const koios = fakeKoios({
      proposalsByReturnAddress: async () => [],
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'stake1retracted',
      onChainRole: 'proposer',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
  });

  // ----- SPO branch (Sprint 3 follow-up — closes the previously-no-op gap) -----

  it('SPO with still-registered pool → still-valid', async () => {
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'registered',
        retiring_epoch: null,
      }),
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1aaaa_active',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('still-valid');
  });

  it('SPO whose pool is absent from pool_list → revoke (definitive deregistration)', async () => {
    const koios = fakeKoios({
      // Adapter returns null when the strict `/pool_list` walk
      // succeeded but no row for this pool id is present. That's the
      // retired-or-never-registered signature.
      poolStatus: async () => null,
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1zzz_gone',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
    if (decision.action === 'revoke') {
      expect(decision.reason).toContain('pool absent');
    }
  });

  it('SPO whose pool_status is retired → revoke', async () => {
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'retired',
        retiring_epoch: 500,
      }),
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1retired',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
    if (decision.action === 'revoke') {
      expect(decision.reason).toContain('retired');
    }
  });

  it('SPO whose koios.poolStatus() throws → upstream-failure (sessions kept)', async () => {
    // Critical fail-safe: a Koios brownout on the SPO branch must NOT
    // strip the session. The cron uses a strict adapter for SPO so
    // upstream errors propagate up here, the surrounding try/catch in
    // `decideForIdentity` maps them to upstream-failure.
    const koios = fakeKoios({
      poolStatus: async () => {
        throw new Error('Koios 503 on /pool_list');
      },
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1survives_brownout',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('upstream-failure');
  });

  // ----- M5 (2026-06-10 security review) — Calidus-key rotation check -----

  it('M5: SPO whose stored Calidus key MATCHES the current pool key → still-valid', async () => {
    const STORED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'registered',
        retiring_epoch: null,
      }),
      poolCalidusKeyByPool: async (poolId: string) => ({
        pool_id_bech32: poolId,
        calidus_pub_key: STORED, // matches!
        calidus_id_bech32: 'calidus1aaa',
        registered: true,
        pool_status: 'registered',
      }),
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1aligned',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      spoCalidusPubKeyHex: STORED,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('still-valid');
  });

  it('M5: SPO whose stored Calidus key DIFFERS from the current key → revoke (rotation)', async () => {
    const STORED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const CURRENT = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'registered',
        retiring_epoch: null,
      }),
      poolCalidusKeyByPool: async (poolId: string) => ({
        pool_id_bech32: poolId,
        calidus_pub_key: CURRENT, // rotated!
        calidus_id_bech32: 'calidus1current',
        registered: true,
        pool_status: 'registered',
      }),
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1rotated',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      spoCalidusPubKeyHex: STORED,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
    if (decision.action === 'revoke') {
      expect(decision.reason).toContain('Calidus key rotated');
    }
  });

  it('M5: SPO whose stored Calidus key is present but the pool has NO current registered key → revoke', async () => {
    // Pool dropped Calidus registration entirely (CIP-151 unregister).
    const STORED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'registered',
        retiring_epoch: null,
      }),
      poolCalidusKeyByPool: async () => null,
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1unregistered_calidus',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      spoCalidusPubKeyHex: STORED,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
    if (decision.action === 'revoke') {
      expect(decision.reason).toContain('Calidus');
    }
  });

  it('M5: SPO whose koios.poolCalidusKeyByPool() throws → upstream-failure (sessions kept, fail-safe)', async () => {
    // Critical fail-safe: a brownout on the Calidus-key lookup must
    // NOT revoke the SPO session. The strict adapter propagates the
    // throw; the surrounding try/catch maps to upstream-failure.
    const STORED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'registered',
        retiring_epoch: null,
      }),
      poolCalidusKeyByPool: async () => {
        throw new Error('Koios 502 on /pool_calidus_keys');
      },
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1calidus_brownout',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      spoCalidusPubKeyHex: STORED,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('upstream-failure');
  });

  it('M5: pre-M5 SPO row (no stored Calidus key) → still-valid (no retroactive rotation check)', async () => {
    // Pre-M5 SPO sessions don't capture the originating Calidus key.
    // The cron MUST NOT revoke them — they age out via the 30-day JWT
    // TTL and the next login post-M5 will start capturing the key.
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'registered',
        retiring_epoch: null,
      }),
      // Even if a current key exists, we have nothing to compare it
      // against, so we don't make the call (and the test verifies
      // that by leaving poolCalidusKeyByPool returning null).
      poolCalidusKeyByPool: async () => null,
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1pre_m5',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      // Notice: NO spoCalidusPubKeyHex.
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('still-valid');
  });

  it('M5: pool retired short-circuits the Calidus check (revoke for retirement, not rotation)', async () => {
    // Even with a stored Calidus key, a retired pool should revoke
    // for pool retirement — the Calidus check is downstream.
    const STORED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'retired',
        retiring_epoch: 500,
      }),
      // Should NOT be called when the pool is retired.
      poolCalidusKeyByPool: async () => {
        throw new Error('poolCalidusKeyByPool should not be called for a retired pool');
      },
    });
    const idx: ActiveSessionIndex = {
      walletAddress: 'pool1retired_with_stored_key',
      onChainRole: 'spo',
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      spoCalidusPubKeyHex: STORED,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('revoke');
    if (decision.action === 'revoke') {
      expect(decision.reason).toContain('retired');
    }
  });

  it('record with no onChainRole → skip-no-role (pre-Sprint-3 backfill)', async () => {
    const koios = fakeKoios();
    const idx: ActiveSessionIndex = {
      walletAddress: 'drep1legacy',
      onChainRole: undefined,
      jtiHashes: ['hash1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const decision = await decideForIdentity(idx, koios);
    expect(decision.action).toBe('skip-no-role');
  });
});

describe('runRevalidateOnChainRoles — wired pass', () => {
  it('still-valid identity keeps its sessions (no revoke call)', async () => {
    const koios = fakeKoios({
      drepInfo: async () => ({
        drep_id: 'drep1aaaa',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
      }),
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1aaaa',
        onChainRole: 'drep',
        jtiHashes: ['h1', 'h2'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 0);

    const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
    expect(result.identitiesScanned).toBe(1);
    expect(result.identitiesChecked).toBe(1);
    expect(result.identitiesStillValid).toBe(1);
    expect(result.identitiesRevoked).toBe(0);
    expect(result.sessionsRevoked).toBe(0);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('now-deregistered identity gets revoked (revoke called exactly once)', async () => {
    const koios = fakeKoios({
      // Null → no row → deregistered.
      drepInfo: async () => null,
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1zzz_gone',
        onChainRole: 'drep',
        jtiHashes: ['h1', 'h2', 'h3'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async (_w: string) => 3);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesRevoked).toBe(1);
      expect(result.sessionsRevoked).toBe(3);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('drep1zzz_gone');
    } finally {
      log.mockRestore();
    }
  });

  it('Koios error leaves sessions intact (NO revoke on thrown lookup)', async () => {
    // The defining fail-safe: a Koios brownout must not strip every
    // active identity's sessions. This proves a per-identity throw
    // does NOT call revoke.
    const koios = fakeKoios({
      drepInfo: async () => {
        throw new Error('Koios 502');
      },
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1survives_brownout',
        onChainRole: 'drep',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesUpstreamFailures).toBe(1);
      expect(result.identitiesRevoked).toBe(0);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('pre-Sprint-3 records (no onChainRole) are skipped, not revoked', async () => {
    const koios = fakeKoios();
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1legacy_no_role',
        onChainRole: undefined,
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesSkippedNoRole).toBe(1);
      expect(result.identitiesRevoked).toBe(0);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('mixed pass: still-valid + revoke + upstream-failure in one run', async () => {
    // Three identities: one DRep (active), one DRep (gone), one
    // proposer whose lookup throws. Only the gone DRep should be
    // revoked; the active DRep and the brownout proposer keep their
    // sessions.
    const koios = fakeKoios({
      drepInfo: async (drepId: string) => {
        if (drepId === 'drep1active') {
          return {
            drep_id: drepId,
            hex: null,
            has_script: false,
            drep_status: 'registered',
            deposit: null,
            active: true,
            expires_epoch_no: null,
          };
        }
        // drep1gone resolves to null → deregistered.
        return null;
      },
      proposalsByReturnAddress: async () => {
        throw new Error('Koios 504');
      },
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1active',
        onChainRole: 'drep',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      {
        walletAddress: 'drep1gone',
        onChainRole: 'drep',
        jtiHashes: ['h2'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      {
        walletAddress: 'stake1brownout',
        onChainRole: 'proposer',
        jtiHashes: ['h3'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesScanned).toBe(3);
      expect(result.identitiesStillValid).toBe(1);
      expect(result.identitiesRevoked).toBe(1);
      expect(result.identitiesUpstreamFailures).toBe(1);
      // Only the deregistered DRep got revoked.
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('drep1gone');
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('enumeration failure → empty result, NO revoke calls (fail-safe)', async () => {
    // The hardest fail-safe: if the session-index Scan throws, we
    // exit the pass without revoking anything. Any other behavior
    // (e.g. revoke based on the partial enumeration) could strip
    // legitimate users out.
    const koios = fakeKoios();
    const enumerator = async (): Promise<ActiveSessionIndex[]> => {
      throw new Error('DDB Scan failed');
    };
    const revoke = vi.fn(async () => 0);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesScanned).toBe(0);
      expect(result.identitiesRevoked).toBe(0);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('zero active identities → no-op pass', async () => {
    const koios = fakeKoios();
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [];
    const revoke = vi.fn(async () => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesScanned).toBe(0);
      expect(result.identitiesRevoked).toBe(0);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('SPO wired pass: still-registered pool keeps its sessions (no revoke call)', async () => {
    const koios = fakeKoios({
      poolStatus: async (poolId: string) => ({
        pool_id_bech32: poolId,
        pool_status: 'registered',
        retiring_epoch: null,
      }),
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'pool1aaaa_active',
        onChainRole: 'spo',
        jtiHashes: ['h1', 'h2'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 0);
    const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
    expect(result.identitiesStillValid).toBe(1);
    expect(result.identitiesRevoked).toBe(0);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('SPO wired pass: retired pool is revoked (revoke called exactly once)', async () => {
    const koios = fakeKoios({
      poolStatus: async () => null,
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'pool1zzz_gone',
        onChainRole: 'spo',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesRevoked).toBe(1);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('pool1zzz_gone');
    } finally {
      log.mockRestore();
    }
  });

  it('SPO wired pass: Koios error leaves the SPO session intact', async () => {
    const koios = fakeKoios({
      poolStatus: async () => {
        throw new Error('Koios 502 on /pool_list');
      },
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'pool1brownout',
        onChainRole: 'spo',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      expect(result.identitiesUpstreamFailures).toBe(1);
      expect(result.identitiesRevoked).toBe(0);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('revoke throw is counted under revokeErrors, does not abort the pass', async () => {
    const koios = fakeKoios({
      drepInfo: async () => null,
    });
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1a',
        onChainRole: 'drep',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      {
        walletAddress: 'drep1b',
        onChainRole: 'drep',
        jtiHashes: ['h2'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    let calls = 0;
    const revoke = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('DDB write failed');
      }
      return 1;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(koios, enumerator, revoke);
      // Both attempted; one errored, one succeeded.
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(result.revokeErrors).toBe(1);
      expect(result.identitiesRevoked).toBe(1);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: the STRICT adapter actually propagates Koios errors.
//
// This is the load-bearing correctness invariant for the whole cron — the
// verify-path `buildKoiosAdapter` swallows errors and returns null/[],
// which would make brownouts indistinguishable from definitive
// deregistrations. The cron uses a strict variant that DOES NOT swallow.
// These tests exercise the default constructor path (no test fake
// injection) end-to-end through the strict adapter against a mocked
// `lib/koios.ts`.
// ---------------------------------------------------------------------------

describe('runRevalidateOnChainRoles — default (strict-adapter) path', () => {
  it('uses STRICT semantics: thrown koios.fetchDRepInfoBatch surfaces as upstream-failure', async () => {
    // Make the underlying koios helper throw — the strict adapter must
    // propagate, NOT catch and return null.
    vi.mocked(koiosHelpers.fetchDRepInfoBatch).mockRejectedValueOnce(
      new Error('Koios 502 Bad Gateway'),
    );
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1strict_brownout',
        onChainRole: 'drep',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      // No `koios` arg → default strict adapter is built.
      const result = await runRevalidateOnChainRoles(undefined, enumerator, revoke);
      // The crucial assertion: a thrown Koios call must NOT revoke. If
      // the strict adapter ever silently returns null on error
      // (regression to the verify-adapter behaviour), this test fails.
      expect(result.identitiesUpstreamFailures).toBe(1);
      expect(result.identitiesRevoked).toBe(0);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('uses STRICT semantics: thrown listAllPools surfaces as upstream-failure on SPO branch', async () => {
    // The SPO branch's load-bearing invariant: a thrown `/pool_list`
    // must propagate so the cron does not mass-revoke every SPO
    // session on a brownout.
    vi.mocked(koiosHelpers.listAllPools).mockRejectedValueOnce(
      new Error('Koios 503 on /pool_list'),
    );
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'pool1strict_brownout',
        onChainRole: 'spo',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await runRevalidateOnChainRoles(undefined, enumerator, revoke);
      expect(result.identitiesUpstreamFailures).toBe(1);
      expect(result.identitiesRevoked).toBe(0);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('uses STRICT semantics: empty listAllPools result for an SPO id = definitive deregistration → revoke', async () => {
    // The successful-but-empty case is the deregistration signal for the
    // strict SPO adapter: `/pool_list` resolved, but no row for this
    // pool id is present. Treat as revoke.
    vi.mocked(koiosHelpers.listAllPools).mockResolvedValueOnce([]);
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'pool1strict_retired',
        onChainRole: 'spo',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await runRevalidateOnChainRoles(undefined, enumerator, revoke);
      expect(result.identitiesRevoked).toBe(1);
      expect(revoke).toHaveBeenCalledWith('pool1strict_retired');
    } finally {
      log.mockRestore();
    }
  });

  it('uses STRICT semantics: empty fetchDRepInfoBatch result = definitive deregistration → revoke', async () => {
    // The other half of the strict-adapter contract: an EMPTY response
    // from the batch helper (no row for this drep id) is definitive —
    // the call succeeded, the chain just doesn't know about this id.
    // That's the deregistration signature; we revoke.
    vi.mocked(koiosHelpers.fetchDRepInfoBatch).mockResolvedValueOnce([]);
    const enumerator = async (): Promise<ActiveSessionIndex[]> => [
      {
        walletAddress: 'drep1strict_deregistered',
        onChainRole: 'drep',
        jtiHashes: ['h1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ];
    const revoke = vi.fn(async () => 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await runRevalidateOnChainRoles(undefined, enumerator, revoke);
      expect(result.identitiesRevoked).toBe(1);
      expect(revoke).toHaveBeenCalledWith('drep1strict_deregistered');
    } finally {
      log.mockRestore();
    }
  });
});
