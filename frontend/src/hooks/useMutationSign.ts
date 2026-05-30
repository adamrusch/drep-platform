import { useCallback } from 'react';
import { post } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

/**
 * Shape of `POST /auth/mutation-nonce` response. The backend issues a
 * single-use nonce and returns the literal `message` string the wallet must
 * sign. The expiry is informational; the server enforces it via the
 * stored DynamoDB record.
 */
interface MutationNonceResponse {
  nonce: string;
  message: string;
  expiresAt: string;
}

/** Cardano CIP-30 wallet API surface — only the bits we use here. */
interface Cip30Api {
  signData: (
    addr: string,
    payloadHex: string,
  ) => Promise<{ signature: string; key: string }>;
}

/**
 * Re-enable a connector via `window.cardano[walletName].enable()` to obtain a
 * fresh CIP-30 API instance. The original instance returned during auth is
 * not retained (per-session, and not safely re-usable across page loads).
 */
async function reEnableWallet(walletName: string): Promise<Cip30Api> {
  const cardano = (window as unknown as { cardano?: Record<string, { enable: () => Promise<Cip30Api> }> })
    .cardano;
  if (!cardano) throw new Error('No Cardano wallet found in this browser');
  const connector = cardano[walletName];
  if (!connector) {
    throw new Error(
      `Wallet "${walletName}" is not available — re-connect from the wallet menu and try again.`,
    );
  }
  const api = await connector.enable();
  if (!api) throw new Error('Wallet did not return an API. Was the connection denied?');
  return api;
}

/** UTF-8 → hex encoder. CIP-30 `signData` expects the payload as hex. */
function toHex(text: string): string {
  const enc = new TextEncoder().encode(text);
  let out = '';
  for (const b of enc) out += b.toString(16).padStart(2, '0');
  return out;
}

export interface SignedMutation {
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

/**
 * Returns a callback that walks through the mutation-signing flow:
 *
 *   1. POST /auth/mutation-nonce → `{ nonce, message }`
 *   2. Build the plaintext: `buildMessage(nonce)` when supplied (committee
 *      mutations sign a stage-bound, action-specific message — see
 *      lib/committeeMessages.ts), else the server's generic `message`.
 *   3. Wallet re-enable + `signData(stakeAddress, hex(plaintext))`
 *   4. Returns the triple the backend expects on the next mutation.
 *
 * The backend verifier reconstructs the SAME plaintext from the request body
 * plus its own stage, so issuer and verifier stay byte-identical.
 *
 * Throws (with a user-readable message) on any failure — the caller is
 * expected to show that as an inline error and let the user retry.
 */
export type MutationMessageBuilder = (nonce: string) => string;

export function useMutationSign(): (
  buildMessage?: MutationMessageBuilder,
) => Promise<SignedMutation> {
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const walletName = useAuthStore((s) => s.walletName);

  return useCallback(
    async (buildMessage?: MutationMessageBuilder): Promise<SignedMutation> => {
      if (!walletAddress) {
        throw new Error('Not authenticated — please reconnect your wallet.');
      }
      if (!walletName) {
        throw new Error(
          'Wallet identity not retained from your last login. Please disconnect and re-connect your wallet, then try again.',
        );
      }

      const nonceResp = await post<MutationNonceResponse>('/auth/mutation-nonce');
      const plaintext = buildMessage ? buildMessage(nonceResp.nonce) : nonceResp.message;

      const api = await reEnableWallet(walletName);
      const messageHex = toHex(plaintext);
      const sig = await api.signData(walletAddress, messageHex);

      if (!sig?.signature || !sig?.key) {
        throw new Error('Wallet returned an invalid signature.');
      }

      return {
        mutationNonce: nonceResp.nonce,
        mutationSignature: sig.signature,
        mutationKey: sig.key,
      };
    },
    [walletAddress, walletName],
  );
}
