/**
 * Tests for the Sprint 1 on-chain login form. Covers the wallet-less
 * paste flow (SPO + CC) end to end, exercises validation, and confirms
 * the auth store is updated with the on-chain roles on success.
 *
 * We mock the API client (`@/lib/api`) at the module boundary so the
 * component runs against a controlled `/auth/onchain/*` response shape.
 * The store is real — assertions look at `useAuthStore.getState()` so
 * a regression in the store wiring would also fail here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const mockPost = vi.fn();

vi.mock('@/lib/api', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

import { OnChainLoginForm } from './OnChainLoginForm';
import { useAuthStore } from '@/stores/authStore';

beforeEach(() => {
  mockPost.mockReset();
  useAuthStore.getState().clearAuth();
});

function configurePasteFlowResponses(role: 'spo' | 'cc', identity: string): void {
  mockPost.mockImplementation(async (url: string) => {
    if (url === '/auth/onchain/challenge') {
      return { payload: 'dreptalk:test:drep.tools:abc:1700000000' };
    }
    if (url === '/auth/onchain/verify') {
      return {
        identity,
        onChainRoles: [role],
        sessionType: 'normal',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        jti: '01H_TEST_JTI',
      };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('OnChainLoginForm — SPO paste flow (wallet-less)', () => {
  it('renders all four role choices', () => {
    const { getByTestId } = render(<OnChainLoginForm />);
    expect(getByTestId('onchain-role-drep')).toBeInTheDocument();
    expect(getByTestId('onchain-role-proposer')).toBeInTheDocument();
    expect(getByTestId('onchain-role-spo')).toBeInTheDocument();
    expect(getByTestId('onchain-role-cc')).toBeInTheDocument();
  });

  it('defaults to SPO and shows paste fields by default', () => {
    const { getByTestId, queryByTestId } = render(<OnChainLoginForm />);
    expect((getByTestId('onchain-role-spo') as HTMLInputElement).checked).toBe(true);
    expect(getByTestId('onchain-public-key')).toBeInTheDocument();
    expect(getByTestId('onchain-signature')).toBeInTheDocument();
    // No wallet hint when no wallet role is selected.
    expect(queryByTestId('onchain-wallet-hint')).toBeNull();
  });

  it('blocks submit when paste fields are empty', async () => {
    const { getByTestId } = render(<OnChainLoginForm />);
    fireEvent.submit(getByTestId('onchain-login-form'));
    await waitFor(() => {
      expect(getByTestId('onchain-error').textContent).toContain(
        'Public key and signature are required.',
      );
    });
    // The form short-circuited — no API call made.
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('posts challenge then verify, then updates store with onChainRoles=["spo"]', async () => {
    configurePasteFlowResponses('spo', 'pool1test_spo_form');

    const onSuccess = vi.fn();
    const { getByTestId } = render(<OnChainLoginForm onSuccess={onSuccess} />);

    fireEvent.change(getByTestId('onchain-public-key'), {
      target: { value: '00'.repeat(32) },
    });
    fireEvent.change(getByTestId('onchain-signature'), {
      target: { value: '11'.repeat(64) },
    });
    fireEvent.submit(getByTestId('onchain-login-form'));

    // Both API calls fire in order.
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/auth/onchain/challenge');
    });
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/onchain/verify',
        expect.objectContaining({
          role: 'spo',
          publicKeyHex: '00'.repeat(32),
          signatureHex: '11'.repeat(64),
        }),
      );
    });

    // Store reflects the new on-chain role.
    await waitFor(() => {
      expect(useAuthStore.getState().onChainRoles).toEqual(['spo']);
    });
    expect(useAuthStore.getState().walletAddress).toBe('pool1test_spo_form');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(getByTestId('onchain-success').textContent).toContain('spo');
  });
});

describe('OnChainLoginForm — CC paste flow', () => {
  it('switches to CC role and posts the cc verify call', async () => {
    configurePasteFlowResponses('cc', 'cc_cold1test_cc_form');

    const { getByTestId } = render(<OnChainLoginForm />);
    fireEvent.click(getByTestId('onchain-role-cc'));

    fireEvent.change(getByTestId('onchain-public-key'), {
      target: { value: 'aa'.repeat(32) },
    });
    fireEvent.change(getByTestId('onchain-signature'), {
      target: { value: 'bb'.repeat(64) },
    });
    fireEvent.submit(getByTestId('onchain-login-form'));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/onchain/verify',
        expect.objectContaining({ role: 'cc' }),
      );
    });

    await waitFor(() => {
      expect(useAuthStore.getState().onChainRoles).toEqual(['cc']);
    });
    expect(useAuthStore.getState().walletAddress).toBe('cc_cold1test_cc_form');
  });
});

describe('OnChainLoginForm — DRep/Proposer wallet flow', () => {
  it('shows the wallet hint and disables submit when no wallet callback is wired', () => {
    const { getByTestId } = render(<OnChainLoginForm />);
    fireEvent.click(getByTestId('onchain-role-drep'));
    expect(getByTestId('onchain-wallet-hint')).toBeInTheDocument();
    expect((getByTestId('onchain-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses the supplied wallet callback when present and ships the signature', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/auth/onchain/challenge') {
        return { payload: 'dreptalk:test:drep.tools:walletflow:1700000000' };
      }
      if (url === '/auth/onchain/verify') {
        return {
          identity: 'drep1test_wallet_drep',
          onChainRoles: ['drep'],
          sessionType: 'normal',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          jti: '01H_WALLET',
        };
      }
      throw new Error(`unexpected ${url}`);
    });

    const onWalletSign = vi.fn(async (_payload: string) => ({
      signatureHex: 'deadbeef',
      keyHex: 'cafe',
    }));

    const { getByTestId } = render(
      <OnChainLoginForm onWalletSign={onWalletSign} initialRole="drep" />,
    );
    fireEvent.submit(getByTestId('onchain-login-form'));

    await waitFor(() => {
      expect(onWalletSign).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/auth/onchain/verify',
        expect.objectContaining({
          role: 'drep',
          signatureHex: 'deadbeef',
          keyHex: 'cafe',
        }),
      );
    });
    await waitFor(() => {
      expect(useAuthStore.getState().onChainRoles).toEqual(['drep']);
    });
  });
});

describe('OnChainLoginForm — error surface', () => {
  it('renders the API error message in-line on failure', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/auth/onchain/challenge') {
        return { payload: 'dreptalk:test:drep.tools:fail:1700000000' };
      }
      const err: { message: string } = { message: 'Not an active SPO' };
      throw err;
    });

    const { getByTestId } = render(<OnChainLoginForm />);
    fireEvent.change(getByTestId('onchain-public-key'), {
      target: { value: '00'.repeat(32) },
    });
    fireEvent.change(getByTestId('onchain-signature'), {
      target: { value: '11'.repeat(64) },
    });
    fireEvent.submit(getByTestId('onchain-login-form'));

    await waitFor(() => {
      expect(getByTestId('onchain-error').textContent).toContain('Not an active SPO');
    });
    expect(useAuthStore.getState().onChainRoles).toEqual([]);
  });
});
