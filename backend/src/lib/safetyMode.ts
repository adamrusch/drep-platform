import { getItem, putItem, queryItems, tableNames } from './dynamodb';
import type { PlatformSafetyModeItem } from './types';

/**
 * Sybil safety-mode latch.
 *
 * Rule: if more than SAFETY_THRESHOLD committees are created within any trailing
 * WINDOW_HOURS, the platform latches into safety mode for LATCH_HOURS (or until
 * a platform_admin clears it). While active, a wallet whose first auth was less
 * than NEW_WALLET_DAYS ago cannot create a committee. Established wallets are
 * unaffected.
 */
export const SAFETY_THRESHOLD = 5; // > 5 in the window trips it
export const WINDOW_HOURS = 12;
export const LATCH_HOURS = 72;
export const NEW_WALLET_DAYS = 7;

const SAFETY_KEY = 'SAFETY_MODE';

export function isSafetyModeActive(
  item: PlatformSafetyModeItem | undefined,
  nowSec: number,
): boolean {
  if (!item?.active) return false;
  if (item.expiresAt !== undefined && nowSec >= item.expiresAt) return false;
  return true;
}

/** True when the wallet first authed less than NEW_WALLET_DAYS ago. */
export function isNewWallet(firstAuthIso: string | undefined, nowMs: number): boolean {
  if (!firstAuthIso) return true; // unknown age → treat as new (fail closed)
  const firstAuthMs = Date.parse(firstAuthIso);
  if (Number.isNaN(firstAuthMs)) return true;
  const ageMs = nowMs - firstAuthMs;
  return ageMs < NEW_WALLET_DAYS * 24 * 60 * 60 * 1000;
}

export async function getSafetyMode(): Promise<PlatformSafetyModeItem | undefined> {
  return getItem<PlatformSafetyModeItem>(tableNames.platformState, { stateKey: SAFETY_KEY });
}

/** Count committees created at or after `sinceIso` via the SK-createdAt-index. */
export async function countRecentCommittees(sinceIso: string): Promise<number> {
  const res = await queryItems<{ drepId: string }>(tableNames.drepCommittees, {
    indexName: 'SK-createdAt-index',
    keyConditionExpression: '#sk = :committee AND #createdAt >= :since',
    expressionAttributeNames: { '#sk': 'SK', '#createdAt': 'createdAt' },
    expressionAttributeValues: { ':committee': 'COMMITTEE', ':since': sinceIso },
  });
  return res.count;
}

/**
 * Trip the latch if creations in the trailing window exceeded the threshold.
 * Idempotent: if already active, leaves the existing (later) expiry in place.
 * Best-effort — callers invoke it after a successful committee creation.
 */
export async function maybeTripSafetyMode(nowMs: number): Promise<boolean> {
  const sinceIso = new Date(nowMs - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const recent = await countRecentCommittees(sinceIso);
  if (recent <= SAFETY_THRESHOLD) return false;

  const nowSec = Math.floor(nowMs / 1000);
  const existing = await getSafetyMode();
  if (isSafetyModeActive(existing, nowSec)) return true; // already latched

  const item: PlatformSafetyModeItem = {
    stateKey: SAFETY_KEY,
    active: true,
    triggeredAt: new Date(nowMs).toISOString(),
    expiresAt: nowSec + LATCH_HOURS * 60 * 60,
    triggeredByCount: recent,
  };
  await putItem(tableNames.platformState, item);
  return true;
}

/** Explicitly clear the latch (platform_admin action). */
export async function clearSafetyMode(clearedBy: string, nowMs: number): Promise<void> {
  const item: PlatformSafetyModeItem = {
    stateKey: SAFETY_KEY,
    active: false,
    clearedBy,
    clearedAt: new Date(nowMs).toISOString(),
  };
  await putItem(tableNames.platformState, item);
}
