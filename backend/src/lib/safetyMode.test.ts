import { describe, it, expect } from 'vitest';
import { isSafetyModeActive, isNewWallet, NEW_WALLET_DAYS } from './safetyMode';
import type { PlatformSafetyModeItem } from './types';

const DAY = 24 * 60 * 60 * 1000;

describe('isSafetyModeActive', () => {
  const now = 1_900_000_000; // epoch seconds

  it('undefined / inactive → false', () => {
    expect(isSafetyModeActive(undefined, now)).toBe(false);
    expect(isSafetyModeActive({ stateKey: 'SAFETY_MODE', active: false } as PlatformSafetyModeItem, now)).toBe(false);
  });

  it('active and unexpired → true', () => {
    const item: PlatformSafetyModeItem = { stateKey: 'SAFETY_MODE', active: true, expiresAt: now + 100 };
    expect(isSafetyModeActive(item, now)).toBe(true);
  });

  it('active but past expiry → false (auto-clears)', () => {
    const item: PlatformSafetyModeItem = { stateKey: 'SAFETY_MODE', active: true, expiresAt: now - 1 };
    expect(isSafetyModeActive(item, now)).toBe(false);
  });

  it('active with no expiry → true', () => {
    expect(isSafetyModeActive({ stateKey: 'SAFETY_MODE', active: true } as PlatformSafetyModeItem, now)).toBe(true);
  });
});

describe('isNewWallet', () => {
  const now = Date.parse('2026-05-30T00:00:00.000Z');

  it('first auth under 7 days ago → new', () => {
    const recent = new Date(now - 2 * DAY).toISOString();
    expect(isNewWallet(recent, now)).toBe(true);
  });

  it('first auth over 7 days ago → not new', () => {
    const old = new Date(now - (NEW_WALLET_DAYS + 1) * DAY).toISOString();
    expect(isNewWallet(old, now)).toBe(false);
  });

  it('exactly 7 days → not new (boundary)', () => {
    const exactly = new Date(now - NEW_WALLET_DAYS * DAY).toISOString();
    expect(isNewWallet(exactly, now)).toBe(false);
  });

  it('unknown / unparseable timestamp → new (fail closed)', () => {
    expect(isNewWallet(undefined, now)).toBe(true);
    expect(isNewWallet('not-a-date', now)).toBe(true);
  });
});
