/**
 * Sprint 1 — on-chain four-role login surface.
 *
 * Functional component (no design-token polish — polish is deferred per
 * the brief's "prioritize a working, tested component over visual polish"
 * note). Supports all four flows declared by the backend
 * `/auth/onchain/verify` handler:
 *
 *   - `drep` / `proposer` — CIP-30 wallet signature, gated on a wallet
 *     being available via `window.cardano[walletName]`. The component
 *     accepts an `onWalletSign` callback so the page can wire it to its
 *     existing wallet adapter (the same one `useWalletAuth.ts` uses for
 *     the legacy CIP-30 login). When no callback is provided, the
 *     wallet-roles tab shows a disabled hint instead of misleading the
 *     user — the form for SPO/CC still works fully.
 *   - `spo` — Calidus pub key + Ed25519 signature pasted from
 *     `cardano-signer` output. Wallet-less.
 *   - `cc` — Ed25519 pub key (hot key) + signature pasted from a CC
 *     member's signing tool. Wallet-less.
 *
 * The component is responsible for the full request flow:
 *   1. POST `/auth/onchain/challenge` to get a stage-bound payload.
 *   2. Either invoke the wallet callback (drep/proposer) or read the
 *      signature pasted by the user (spo/cc).
 *   3. POST `/auth/onchain/verify`.
 *   4. On success, push `{ onChainRoles, identity }` into the auth
 *      store so `useHasOnChainRole` reflects the new role immediately.
 *
 * Errors are surfaced inline (no toast dependency — this component is a
 * leaf and shouldn't drag in the global UI store). Loading state is
 * tracked locally; the caller can wrap in their own `<Card>` chrome.
 */
import React, { useCallback, useState } from 'react';
import { post } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import type { OnChainRole, SessionType } from '@/types';

type Role = OnChainRole; // alias for local readability

interface ChallengeResponse {
  payload: string;
}

interface VerifyResponse {
  identity: string;
  onChainRoles: OnChainRole[];
  sessionType: SessionType;
  expiresAt: string;
  jti: string;
}

/** Wallet-callback signature — matches what CIP-30 `signData` returns.
 *  The caller's wallet adapter wraps the underlying CIP-8 COSE_Sign1 and
 *  COSE_Key into the supplied `{signatureHex, keyHex}`. We do not invoke
 *  the wallet ourselves — the page owns wallet selection state. */
export type WalletSignFn = (payload: string) => Promise<{
  signatureHex: string;
  keyHex: string;
}>;

export interface OnChainLoginFormProps {
  /** Optional wallet-sign callback for the DRep / Proposer flows. When
   *  absent, those tabs are disabled with an explanatory hint and the
   *  user can still authenticate as SPO / CC via paste. */
  onWalletSign?: WalletSignFn;
  /** Optional callback fired on successful verify. Receives the verify
   *  response so the host can navigate / toast / refetch profile. */
  onSuccess?: (result: VerifyResponse) => void;
  /** Optional initial role tab. Defaults to `spo` because the paste flow
   *  has no external dependency. */
  initialRole?: Role;
}

const ROLE_LABELS: Record<Role, string> = {
  drep: 'DRep (wallet)',
  proposer: 'Proposer (wallet)',
  spo: 'SPO (Calidus paste)',
  cc: 'CC member (paste)',
};

export function OnChainLoginForm({
  onWalletSign,
  onSuccess,
  initialRole = 'spo',
}: OnChainLoginFormProps): React.ReactElement {
  const [role, setRole] = useState<Role>(initialRole);
  const [publicKeyHex, setPublicKeyHex] = useState('');
  const [signatureHex, setSignatureHex] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const setAuth = useAuthStore((s) => s.setAuth);

  const isWalletRole = role === 'drep' || role === 'proposer';
  const walletDisabled = isWalletRole && !onWalletSign;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSuccess(null);

      if (isWalletRole && !onWalletSign) {
        setError(
          'No wallet adapter wired. Connect your wallet first, or sign in as SPO / CC.',
        );
        return;
      }
      if (!isWalletRole) {
        if (!publicKeyHex.trim() || !signatureHex.trim()) {
          setError('Public key and signature are required.');
          return;
        }
      }

      setLoading(true);
      try {
        // 1. Get a stage-bound challenge payload.
        const challenge = await post<ChallengeResponse>('/auth/onchain/challenge');

        // 2. Produce the signature.
        let body: Record<string, unknown>;
        if (isWalletRole) {
          const signed = await onWalletSign!(challenge.payload);
          body = {
            payload: challenge.payload,
            signatureHex: signed.signatureHex,
            keyHex: signed.keyHex,
            role,
            rememberMe,
          };
        } else {
          body = {
            payload: challenge.payload,
            signatureHex: signatureHex.trim().toLowerCase(),
            publicKeyHex: publicKeyHex.trim().toLowerCase(),
            role,
            rememberMe,
          };
        }

        // 3. Verify with the backend — server sets the on-chain cookie.
        const verifyResult = await post<VerifyResponse>('/auth/onchain/verify', body);

        // 4. Sync local store. We do NOT pass `walletName` because the
        //    on-chain flow may not involve a CIP-30 wallet (SPO / CC use
        //    a paste flow). The legacy `walletAddress` slot carries the
        //    on-chain identity here — that's the JWT's `sub` claim.
        //
        //    `roles` defaults to `['guest']` to match the JWT shape the
        //    backend mints (see `onchainVerify.ts`). The on-chain roles
        //    travel in the parallel `onChainRoles` slot.
        setAuth({
          walletAddress: verifyResult.identity,
          roles: ['guest'],
          onChainRoles: verifyResult.onChainRoles,
          sessionType: verifyResult.sessionType,
          expiresAt: verifyResult.expiresAt,
        });

        setSuccess(
          `Signed in as ${verifyResult.onChainRoles.join(', ')} (${verifyResult.identity}).`,
        );
        onSuccess?.(verifyResult);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : (err as { message?: string }).message ?? 'On-chain login failed';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [
      isWalletRole,
      onWalletSign,
      publicKeyHex,
      signatureHex,
      role,
      rememberMe,
      setAuth,
      onSuccess,
    ],
  );

  return (
    <form onSubmit={handleSubmit} data-testid="onchain-login-form" className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="font-semibold">Identity</legend>
        {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
          <label key={r} className="flex items-center gap-2">
            <input
              type="radio"
              name="onchain-role"
              value={r}
              checked={role === r}
              onChange={() => {
                setRole(r);
                setError(null);
              }}
              data-testid={`onchain-role-${r}`}
            />
            <span>{ROLE_LABELS[r]}</span>
          </label>
        ))}
      </fieldset>

      {walletDisabled && (
        <p data-testid="onchain-wallet-hint" className="text-sm text-muted-foreground">
          A CIP-30 wallet adapter is required for DRep and Proposer login. Connect a
          wallet first, or pick SPO / CC to use the paste flow.
        </p>
      )}

      {!isWalletRole && (
        <>
          <label className="block">
            <span className="block text-sm font-medium">Public key (hex, 64 chars)</span>
            <input
              type="text"
              value={publicKeyHex}
              onChange={(e) => setPublicKeyHex(e.target.value)}
              data-testid="onchain-public-key"
              required
              spellCheck={false}
              autoComplete="off"
              className="mt-1 block w-full rounded border px-2 py-1 font-mono text-xs"
              placeholder="3f4c…"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium">Signature (hex, 128 chars)</span>
            <textarea
              value={signatureHex}
              onChange={(e) => setSignatureHex(e.target.value)}
              data-testid="onchain-signature"
              required
              spellCheck={false}
              autoComplete="off"
              rows={3}
              className="mt-1 block w-full rounded border px-2 py-1 font-mono text-xs"
              placeholder="1a2b3c…"
            />
          </label>
        </>
      )}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={rememberMe}
          onChange={(e) => setRememberMe(e.target.checked)}
          data-testid="onchain-remember-me"
        />
        <span className="text-sm">Remember me (30-day session)</span>
      </label>

      {error && (
        <p data-testid="onchain-error" role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {success && (
        <p data-testid="onchain-success" className="text-sm text-green-600">
          {success}
        </p>
      )}

      <button
        type="submit"
        disabled={loading || walletDisabled}
        data-testid="onchain-submit"
        className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
      >
        {loading ? 'Signing in…' : 'Sign in on-chain'}
      </button>
    </form>
  );
}
