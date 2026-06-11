/**
 * Decision #3 (2026-06-10) — link credential form tests.
 *
 * Functional coverage:
 *   - The four role choices render.
 *   - SPO paste flow: challenge → sign → verify happy path.
 *   - SAFETY surface: a 409 (credential mapped to a different
 *     person) is surfaced inline with the actionable error message.
 *
 * Wallet flows mirror the login form's wallet test approach — we
 * inject a fake `onWalletSign` so the test is hermetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const mockPost = vi.fn();

vi.mock('@/lib/api', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

import { LinkCredentialForm } from './LinkCredentialForm';

beforeEach(() => {
  mockPost.mockReset();
});

function configureHappyPath(role: 'spo' | 'cc', credentialId: string): void {
  mockPost.mockImplementation(async (url: string) => {
    if (url === '/auth/onchain/link/challenge') {
      return { payload: 'dreptalk:test:drep.tools:abc:1700000000' };
    }
    if (url === '/auth/onchain/link/verify') {
      return {
        personId: '01HZ_test_person',
        linked: {
          identityKey: `${role === 'spo' ? 'pool' : 'cc'}:${credentialId}`,
          credentialType: role === 'spo' ? 'pool' : 'cc',
          credentialId,
          role,
        },
        alreadyLinked: false,
      };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('LinkCredentialForm — rendering', () => {
  it('renders all four role choices', () => {
    const { getByTestId } = render(<LinkCredentialForm />);
    expect(getByTestId('link-role-drep')).toBeInTheDocument();
    expect(getByTestId('link-role-proposer')).toBeInTheDocument();
    expect(getByTestId('link-role-spo')).toBeInTheDocument();
    expect(getByTestId('link-role-cc')).toBeInTheDocument();
  });

  it('defaults to SPO and shows paste fields', () => {
    const { getByTestId } = render(<LinkCredentialForm />);
    expect((getByTestId('link-role-spo') as HTMLInputElement).checked).toBe(true);
    expect(getByTestId('link-public-key')).toBeInTheDocument();
    expect(getByTestId('link-signature')).toBeInTheDocument();
  });

  it('shows the wallet hint and disables submit when wallet role selected without a wallet', () => {
    const { getByTestId } = render(<LinkCredentialForm />);
    fireEvent.click(getByTestId('link-role-drep'));
    expect(getByTestId('link-wallet-hint')).toBeInTheDocument();
    expect((getByTestId('link-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('LinkCredentialForm — SPO paste happy path', () => {
  it('submits challenge → verify and reports success', async () => {
    const POOL = 'pool1happy_link';
    configureHappyPath('spo', POOL);
    const onSuccess = vi.fn();

    const { getByTestId } = render(<LinkCredentialForm onSuccess={onSuccess} />);
    fireEvent.change(getByTestId('link-public-key'), {
      target: { value: 'ab'.repeat(32) },
    });
    fireEvent.change(getByTestId('link-signature'), {
      target: { value: 'cd'.repeat(64) },
    });
    fireEvent.click(getByTestId('link-submit'));

    await waitFor(() => {
      expect(getByTestId('link-success')).toBeInTheDocument();
    });
    expect(mockPost).toHaveBeenCalledWith('/auth/onchain/link/challenge');
    expect(mockPost).toHaveBeenCalledWith(
      '/auth/onchain/link/verify',
      expect.objectContaining({ role: 'spo', publicKeyHex: 'ab'.repeat(32) }),
    );
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ linked: expect.objectContaining({ role: 'spo' }) }),
    );
    expect(getByTestId('link-success').textContent).toMatch(POOL);
  });
});

describe('LinkCredentialForm — refusal of cross-person merge', () => {
  it('surfaces a 409 conflict error inline (no silent merge)', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/auth/onchain/link/challenge') {
        return { payload: 'dreptalk:test:drep.tools:abc:1700000000' };
      }
      if (url === '/auth/onchain/link/verify') {
        // Mirrors the backend's 409 ApiError shape from `lib/api.ts`'s
        // response interceptor.
        return Promise.reject({
          error: 'Conflict',
          message:
            'This credential is already linked to another account. Account merge is not supported.',
          statusCode: 409,
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { getByTestId } = render(<LinkCredentialForm />);
    fireEvent.change(getByTestId('link-public-key'), {
      target: { value: 'ab'.repeat(32) },
    });
    fireEvent.change(getByTestId('link-signature'), {
      target: { value: 'cd'.repeat(64) },
    });
    fireEvent.click(getByTestId('link-submit'));

    await waitFor(() => {
      expect(getByTestId('link-error')).toBeInTheDocument();
    });
    expect(getByTestId('link-error').textContent).toMatch(/already linked/i);
  });
});

describe('LinkCredentialForm — idempotent re-link', () => {
  it('reports the already-linked status when the backend says alreadyLinked', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/auth/onchain/link/challenge') {
        return { payload: 'dreptalk:test:drep.tools:abc:1700000000' };
      }
      if (url === '/auth/onchain/link/verify') {
        return {
          personId: '01HZ_same_person',
          linked: {
            identityKey: 'pool:pool1same',
            credentialType: 'pool',
            credentialId: 'pool1same',
            role: 'spo',
          },
          alreadyLinked: true,
        };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { getByTestId } = render(<LinkCredentialForm />);
    fireEvent.change(getByTestId('link-public-key'), {
      target: { value: 'ab'.repeat(32) },
    });
    fireEvent.change(getByTestId('link-signature'), {
      target: { value: 'cd'.repeat(64) },
    });
    fireEvent.click(getByTestId('link-submit'));

    await waitFor(() => {
      expect(getByTestId('link-success')).toBeInTheDocument();
    });
    expect(getByTestId('link-success').textContent).toMatch(/already linked/i);
  });
});
