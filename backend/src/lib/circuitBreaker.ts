/**
 * Persistent circuit breaker for Blockfrost rate-limit (402 / 429) failures.
 *
 * Problem: when the Blockfrost daily quota is exceeded, every subsequent
 * request returns 402 BUT the rejected calls themselves count against the
 * rolling window — meaning a sync that fires every 10 minutes hammering
 * 402s can prevent the window from ever clearing.
 *
 * Fix: when the sync sees a 402/429, write a circuit-open marker to
 * DynamoDB (via the existing auth_nonces table since it already has TTL
 * configured). On entry, the sync checks the marker; if it's still valid,
 * the sync skips the run entirely without touching Blockfrost. The marker
 * auto-expires via the table's TTL attribute, after which the next sync
 * attempts a fresh probe.
 */

import { putItem, getItem, tableNames } from './dynamodb';

const CIRCUIT_KEY = '_circuit:blockfrost';

/** Open the circuit for the given duration. Default: 6 hours. */
export async function openBlockfrostCircuit(ttlSeconds = 6 * 60 * 60): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  await putItem(tableNames.authNonces, {
    nonce: CIRCUIT_KEY,
    kind: 'circuit',
    walletAddress: '_system',
    expiresAt,
    openedAt: new Date().toISOString(),
  });
}

/** True if the circuit is currently open (sync should skip). */
export async function isBlockfrostCircuitOpen(): Promise<{ open: boolean; expiresAt?: number }> {
  const item = await getItem<{
    nonce: string;
    kind: string;
    expiresAt: number;
  }>(tableNames.authNonces, { nonce: CIRCUIT_KEY });
  if (!item || item.kind !== 'circuit') return { open: false };
  // DynamoDB TTL deletion is best-effort with multi-minute lag, so check
  // expiry inline rather than relying on the table to scrub.
  if (Date.now() / 1000 > item.expiresAt) return { open: false };
  return { open: true, expiresAt: item.expiresAt };
}

/**
 * Type guard / pattern-matcher for "this Blockfrost error is a quota/throttle
 * signal we should open the circuit on."
 */
export function isBlockfrostQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status_code?: number; statusCode?: number; name?: string; message?: string };
  const status = e.status_code ?? e.statusCode;
  if (status === 402 || status === 429) return true;
  if (typeof e.message === 'string') {
    const m = e.message.toLowerCase();
    if (m.includes('over limit') || m.includes('rate limit') || m.includes('too many requests')) {
      return true;
    }
  }
  return false;
}
