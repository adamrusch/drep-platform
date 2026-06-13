/**
 * Decision #3 (2026-06-10) — credential-linking surface.
 *
 * Functional component (deferred polish — same brief as
 * `OnChainLoginForm`). The caller is ALREADY signed in via an on-
 * chain session; this form lets them link an ADDITIONAL on-chain
 * credential to the same canonical person.
 *
 * Two flows mirror the login form's four-role surface but with the
 * credential they're linking AS A NEW credential:
 *
 *   - `drep` / `proposer` — CIP-30 wallet signature. The component
 *     reuses the SAME `useDefaultWalletSign` hook the login form
 *     does, so a connected wallet just works.
 *   - `spo` / `cc` — Ed25519 pub key + signature pasted from the
 *     user's signing tool (cardano-signer for SPO Calidus, or the
 *     CC member's hot-key tool).
 *
 * # Request flow
 *
 *   1. POST `/auth/onchain/link/challenge` — auth-gated. Returns a
 *      stage-bound payload.
 *   2. Sign the payload with the NEW credential.
 *   3. POST `/auth/onchain/link/verify` — auth-gated. The backend
 *      verifies the signature with the same rigor as login, then
 *      maps the new credential to the caller's existing personId.
 *
 * # Safety surface
 *
 * The backend rejects a link when the credential is already mapped
 * to a DIFFERENT person (HTTP 409). We surface that error inline
 * with a clear message — DO NOT auto-retry or "fix" anything; the
 * user has to use the original account or contact support.
 */
import React, { useCallback, useState } from 'react';
import { post } from '@/lib/api';
import type { OnChainRole } from '@/types';
import {
  type WalletSignFn,
  useDefaultWalletSign,
} from './OnChainLoginForm';

interface ChallengeResponse {
  payload: string;
}

interface LinkVerifyResponse {
  personId: string;
  linked: {
    identityKey: string;
    credentialType: string;
    credentialId: string;
    role: OnChainRole;
  };
  alreadyLinked: boolean;
}

const ROLE_LABELS: Record<OnChainRole, string> = {
  drep: 'DRep (wallet)',
  proposer: 'Proposer (wallet)',
  spo: 'SPO (Calidus paste)',
  cc: 'CC member (paste)',
};

export interface LinkCredentialFormProps {
  /** Optional override for the wallet sign callback. When absent,
   *  the component derives one from the auth store via
   *  `useDefaultWalletSign` — same hook the login form uses. */
  onWalletSign?: WalletSignFn;
  /** Optional callback fired on successful link. Hosts can refetch
   *  `/auth/onchain/me` to refresh the credential list. */
  onSuccess?: (result: LinkVerifyResponse) => void;
  /** Initial role tab. Defaults to `spo` because the paste flow
   *  has no external dependency. */
  initialRole?: OnChainRole;
}

export function LinkCredentialForm({
  onWalletSign,
  onSuccess,
  initialRole = 'spo',
}: LinkCredentialFormProps): React.ReactElement {
  const [role, setRole] = useState<OnChainRole>(initialRole);
  const [publicKeyHex, setPublicKeyHex] = useState('');
  const [signatureHex, setSignatureHex] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const defaultWalletSign = useDefaultWalletSign();
  const effectiveWalletSign = onWalletSign ?? defaultWalletSign;
  const isWalletRole = role === 'drep' || role === 'proposer';
  const walletDisabled = isWalletRole && !effectiveWalletSign;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSuccess(null);

      if (isWalletRole && !effectiveWalletSign) {
        setError(
          'No wallet adapter wired. Connect your wallet first, or pick SPO / CC.',
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
        // 1. Auth-gated challenge.
        const challenge = await post<ChallengeResponse>('/auth/onchain/link/challenge');

        // 2. Produce a signature over the challenge payload.
        let body: Record<string, unknown>;
        if (isWalletRole) {
          const signed = await effectiveWalletSign!(challenge.payload);
          body = {
            payload: challenge.payload,
            signatureHex: signed.signatureHex,
            keyHex: signed.keyHex,
            role,
          };
        } else {
          body = {
            payload: challenge.payload,
            signatureHex: signatureHex.trim().toLowerCase(),
            publicKeyHex: publicKeyHex.trim().toLowerCase(),
            role,
          };
        }

        // 3. Verify + link. SAFETY: a 409 from the backend means
        // the credential is already linked to ANOTHER person — we
        // do NOT silently merge.
        const result = await post<LinkVerifyResponse>('/auth/onchain/link/verify', body);

        if (result.alreadyLinked) {
          setSuccess(
            `Already linked. ${ROLE_LABELS[result.linked.role]} (${result.linked.credentialId}) is mapped to your account.`,
          );
        } else {
          setSuccess(
            `Linked ${ROLE_LABELS[result.linked.role]} (${result.linked.credentialId}).`,
          );
        }
        onSuccess?.(result);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : (err as { message?: string }).message ?? 'Link failed';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [
      isWalletRole,
      effectiveWalletSign,
      publicKeyHex,
      signatureHex,
      role,
      onSuccess,
    ],
  );

  return (
    <form onSubmit={handleSubmit} data-testid="link-credential-form" className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="font-semibold">Link another identity</legend>
        <p className="text-sm text-muted-foreground">
          Prove control of an additional on-chain credential so we recognise it as
          belonging to your account.
        </p>
        {(Object.keys(ROLE_LABELS) as OnChainRole[]).map((r) => (
          <label key={r} className="flex items-center gap-2">
            <input
              type="radio"
              name="link-credential-role"
              value={r}
              checked={role === r}
              onChange={() => {
                setRole(r);
                setError(null);
              }}
              data-testid={`link-role-${r}`}
            />
            <span>{ROLE_LABELS[r]}</span>
          </label>
        ))}
      </fieldset>

      {walletDisabled && (
        <p data-testid="link-wallet-hint" className="text-sm text-muted-foreground">
          A CIP-30 wallet adapter is required for DRep and Proposer linking.
          Connect a wallet first, or pick SPO / CC.
        </p>
      )}

      {!isWalletRole && (
        <>
          <label className="block">
            <span className="block text-sm font-medium">Public key (hex)</span>
            <input
              type="text"
              value={publicKeyHex}
              onChange={(e) => setPublicKeyHex(e.target.value)}
              data-testid="link-public-key"
              required
              spellCheck={false}
              autoComplete="off"
              className="mt-1 block w-full rounded border px-2 py-1 font-mono text-xs"
              placeholder="3f4c…"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium">Signature (hex)</span>
            <textarea
              value={signatureHex}
              onChange={(e) => setSignatureHex(e.target.value)}
              data-testid="link-signature"
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

      {error && (
        <p data-testid="link-error" role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {success && (
        <p data-testid="link-success" className="text-sm text-green-600">
          {success}
        </p>
      )}

      <button
        type="submit"
        disabled={loading || walletDisabled}
        data-testid="link-submit"
        className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
      >
        {loading ? 'Linking…' : 'Link identity'}
      </button>
    </form>
  );
}
