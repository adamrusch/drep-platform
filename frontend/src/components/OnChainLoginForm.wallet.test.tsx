/**
 * Tests for the Sprint 1 wallet-adapter wiring on `OnChainLoginForm`.
 *
 * Sprint 1 left the DRep / Proposer paths working only when the host
 * explicitly supplied `onWalletSign`. This corpus pins the follow-up
 * fix where the form derives a default `WalletSignFn` from the legacy
 * wallet store (`walletName`), so the DRep + Proposer flows now work
 * end-to-end with just the connected wallet:
 *
 *   1. The form reads `walletName` from the auth store.
 *   2. The DRep tab renders the submit button (no "no wallet adapter"
 *      hint) when `walletName` is present.
 *   3. On submit, the default sign callback:
 *        a. re-enables the CIP-30 wallet via `window.cardano[name]`,
 *        b. pulls a hex `addr` from `getRewardAddresses` (with a
 *           used-address fallback),
 *        c. posts `payload + signatureHex + keyHex + role: 'drep'` to
 *           `/auth/onchain/verify`.
 *   4. The auth store gets populated with `onChainRoles: ['drep']`.
 *
 * The store is real — we set / clear `walletName` via the public store
 * API rather than mocking it, so a regression in the store wiring would
 * also fail here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const mockPost = vi.fn();

vi.mock('@/lib/api', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

import { OnChainLoginForm } from './OnChainLoginForm';
import { useAuthStore } from '@/stores/authStore';

interface FakeCip30Api {
  enable: () => Promise<FakeCip30Api>;
  signData: (addr: string, payloadHex: string) => Promise<{ signature: string; key: string }>;
  getRewardAddresses: () => Promise<string[]>;
  getUsedAddresses: () => Promise<string[]>;
}

interface WindowWithCardano {
  cardano?: Record<string, { enable: () => Promise<FakeCip30Api> }>;
}

beforeEach(() => {
  mockPost.mockReset();
  useAuthStore.getState().clearAuth();
  delete (window as unknown as WindowWithCardano).cardano;
});

function installFakeWallet(opts: {
  walletName?: string;
  signature?: string;
  key?: string;
  rewardAddrHex?: string;
}): {
  signData: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
} {
  const name = opts.walletName ?? 'eternl';
  const signData = vi.fn(async () => ({
    signature: opts.signature ?? 'deadbeefcafe',
    key: opts.key ?? 'a0b1c2d3',
  }));
  const api: FakeCip30Api = {
    enable: vi.fn(async () => api),
    signData,
    getRewardAddresses: async () => [opts.rewardAddrHex ?? 'e0aabbccddeeff'],
    getUsedAddresses: async () => ['01112233'],
  };
  const enable = vi.fn(async () => api);
  (window as unknown as WindowWithCardano).cardano = {
    [name]: { enable },
  };
  return { signData, enable };
}

function configureVerifyResponses(opts: {
  role: 'drep' | 'proposer';
  identity: string;
}): void {
  mockPost.mockImplementation(async (url: string) => {
    if (url === '/auth/onchain/challenge') {
      return { payload: 'dreptalk:test:drep.tools:walletwire:1700000000' };
    }
    if (url === '/auth/onchain/verify') {
      return {
        identity: opts.identity,
        onChainRoles: [opts.role],
        sessionType: 'normal',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        jti: '01H_WALLETWIRE',
      };
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe('OnChainLoginForm — default wallet wiring (Sprint 1 follow-up)', () => {
  it('renders the disabled wallet hint when no walletName is in the auth store', () => {
    const { getByTestId } = render(<OnChainLoginForm />);
    fireEvent.click(getByTestId('onchain-role-drep'));
    // No wallet connected → the form falls back to the disabled hint.
    expect(getByTestId('onchain-wallet-hint')).toBeInTheDocument();
    expect((getByTestId('onchain-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the DRep tab when the auth store carries a walletName', () => {
    // Seed the store as if the user had connected via the standard
    // WalletButton flow.
    useAuthStore.getState().setAuth({
      walletAddress: 'stake1uxyz...',
      walletName: 'eternl',
      roles: ['delegator'],
      sessionType: 'normal',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    installFakeWallet({ walletName: 'eternl' });

    const { getByTestId, queryByTestId } = render(<OnChainLoginForm />);
    fireEvent.click(getByTestId('onchain-role-drep'));
    // No hint, submit not disabled by the walletDisabled gate.
    expect(queryByTestId('onchain-wallet-hint')).toBeNull();
    expect((getByTestId('onchain-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('DRep flow: challenge → wallet.signData → verify, then onChainRoles=["drep"]', async () => {
    useAuthStore.getState().setAuth({
      walletAddress: 'stake1udrepowner',
      walletName: 'eternl',
      roles: ['delegator'],
      sessionType: 'normal',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { signData, enable } = installFakeWallet({
      walletName: 'eternl',
      rewardAddrHex: 'e0aabbccddeeff',
      signature: '11223344',
      key: 'aabbccdd',
    });
    configureVerifyResponses({ role: 'drep', identity: 'drep1default_wire' });

    const onSuccess = vi.fn();
    const { getByTestId } = render(
      <OnChainLoginForm initialRole="drep" onSuccess={onSuccess} />,
    );
    fireEvent.submit(getByTestId('onchain-login-form'));

    // 1. challenge POST fires
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/auth/onchain/challenge');
    });

    // 2. Wallet re-enable + signData both called, signData passes the
    //    payload hex (utf-8 → hex of the challenge payload).
    await waitFor(() => {
      expect(enable).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(signData).toHaveBeenCalledTimes(1);
    });
    const signDataArgs = signData.mock.calls[0]!;
    expect(signDataArgs[0]).toBe('e0aabbccddeeff');
    // payload "dreptalk:test:drep.tools:walletwire:1700000000" →
    // utf-8 → hex prefix check (a quick lexical-shape check, not a
    // full byte-by-byte compare).
    expect(signDataArgs[1]).toMatch(/^[0-9a-f]+$/);
    expect(signDataArgs[1].length).toBeGreaterThan(2);

    // 3. verify POST carries the right shape.
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/onchain/verify',
        expect.objectContaining({
          role: 'drep',
          signatureHex: '11223344',
          keyHex: 'aabbccdd',
          payload: 'dreptalk:test:drep.tools:walletwire:1700000000',
        }),
      );
    });

    // 4. auth store populated with onChainRoles.
    await waitFor(() => {
      expect(useAuthStore.getState().onChainRoles).toEqual(['drep']);
    });
    expect(useAuthStore.getState().walletAddress).toBe('drep1default_wire');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('Proposer flow: same wallet plumbing as DRep, role flips to proposer', async () => {
    useAuthStore.getState().setAuth({
      walletAddress: 'stake1uproposer',
      walletName: 'eternl',
      roles: ['delegator'],
      sessionType: 'normal',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    installFakeWallet({ walletName: 'eternl' });
    configureVerifyResponses({ role: 'proposer', identity: 'stake1uproposer_winner' });

    const { getByTestId } = render(<OnChainLoginForm initialRole="proposer" />);
    fireEvent.submit(getByTestId('onchain-login-form'));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/onchain/verify',
        expect.objectContaining({ role: 'proposer' }),
      );
    });
    await waitFor(() => {
      expect(useAuthStore.getState().onChainRoles).toEqual(['proposer']);
    });
  });

  it('host-supplied onWalletSign overrides the default (used by existing tests)', async () => {
    // Even when the store has a walletName, an explicit callback wins.
    useAuthStore.getState().setAuth({
      walletAddress: 'stake1uoverridable',
      walletName: 'eternl',
      roles: ['delegator'],
      sessionType: 'normal',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { enable } = installFakeWallet({ walletName: 'eternl' });
    configureVerifyResponses({ role: 'drep', identity: 'drep1override' });

    const onWalletSign = vi.fn(async () => ({
      signatureHex: 'feedface',
      keyHex: 'beefbeef',
    }));

    const { getByTestId } = render(
      <OnChainLoginForm initialRole="drep" onWalletSign={onWalletSign} />,
    );
    fireEvent.submit(getByTestId('onchain-login-form'));

    await waitFor(() => {
      expect(onWalletSign).toHaveBeenCalledTimes(1);
    });
    // The store-derived wallet was NEVER re-enabled because the host
    // override short-circuited the default.
    expect(enable).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/onchain/verify',
        expect.objectContaining({
          role: 'drep',
          signatureHex: 'feedface',
          keyHex: 'beefbeef',
        }),
      );
    });
  });
});
