/**
 * Regression tests for the `drep-voting-power-history` sync's TTL
 * attribute on POWER rows (2026-05-27).
 *
 * # Why TTL matters
 *
 * The sync writes ~1623 POWER#NNNNNN rows per day on mainnet. After 6
 * months that's ~300k extra items in the `drep_directory` table; after
 * 2 years, ~1.2M. Without TTL these accumulate forever, bloating PITR
 * backups and increasing scan-class operation cost.
 *
 * The sparkline only renders ~1 year of history, so anything older
 * than 365 days has no UX value — perfect candidate for auto-expiry.
 *
 * # Sparse TTL contract
 *
 *   - DynamoDB TTL is enabled on the `ttl` attribute (see
 *     `infra/lib/database-stack.ts:drepDirectoryTable`).
 *   - ONLY POWER rows carry `ttl`. PROFILE rows do NOT — if they did,
 *     entire DReps would silently vanish from the directory. The
 *     module header in `drep-voting-power-history.ts` calls this out.
 *
 * # What we lock in
 *
 *   1. `buildPowerRow` always sets a `ttl` attribute.
 *   2. The `ttl` value is ~365 days in the future, expressed in Unix
 *      epoch seconds (DynamoDB TTL's required format).
 *   3. The row shape matches the documented contract (PK, SK shape,
 *      epochNo, amount, capturedAt).
 *   4. PROFILE rows are not touched by this sync — the test asserts no
 *      Put goes out with `SK = 'PROFILE'`. (Defense against a future
 *      accidental refactor that copies a PROFILE Put into the sync.)
 */

import { describe, it, expect } from 'vitest';
import { buildPowerRow } from './drep-voting-power-history';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

describe('buildPowerRow — TTL attribute', () => {
  it('sets ttl to nowMs/1000 + 365 days', async () => {
    // Pin nowMs to a known instant so we can do byte-exact assertions
    // against the TTL value.
    const nowMs = Date.UTC(2026, 4, 27, 0, 0, 0); // 2026-05-27 00:00 UTC
    const row = buildPowerRow({
      drepId: 'drep1abc',
      epochNo: 515,
      amount: '12345678901234',
      capturedAt: new Date(nowMs).toISOString(),
      nowMs,
    });

    const expectedTtl = Math.floor(nowMs / 1000) + ONE_YEAR_SECONDS;
    expect(row.ttl).toBe(expectedTtl);
  });

  it('produces a ttl that is ~365 days in the future', async () => {
    // Same property tested at "now", to lock in the order-of-magnitude
    // contract independent of any fixed instant.
    const nowMs = Date.now();
    const row = buildPowerRow({
      drepId: 'drep1xyz',
      epochNo: 600,
      amount: '1',
      capturedAt: new Date(nowMs).toISOString(),
      nowMs,
    });

    const drift = row.ttl - Math.floor(nowMs / 1000);
    // Allow a 1-minute slop window for test-runner scheduling jitter.
    // The actual delta is exact since both numbers come from the same
    // nowMs, but the assertion below is shaped to be robust against
    // future refactors that derive nowMs separately.
    expect(drift).toBeGreaterThanOrEqual(ONE_YEAR_SECONDS - 60);
    expect(drift).toBeLessThanOrEqual(ONE_YEAR_SECONDS + 60);
  });

  it('emits ttl as a NUMBER (Unix epoch seconds), the format DynamoDB TTL requires', async () => {
    const nowMs = Date.UTC(2026, 4, 27, 0, 0, 0);
    const row = buildPowerRow({
      drepId: 'drep1abc',
      epochNo: 515,
      amount: '0',
      capturedAt: new Date(nowMs).toISOString(),
      nowMs,
    });

    expect(typeof row.ttl).toBe('number');
    expect(Number.isInteger(row.ttl)).toBe(true);
    // 2026-05-27 + 365d = ~2027-05-27. As Unix seconds this lives in
    // the 1.7B-1.9B range. A value in the millisecond range (~1.7T)
    // would be a sign someone forgot the /1000 conversion.
    expect(row.ttl).toBeGreaterThan(1_700_000_000);
    expect(row.ttl).toBeLessThan(2_000_000_000);
  });

  it('builds an SK of `POWER#${zero-padded epoch}`', async () => {
    const nowMs = Date.now();
    const row = buildPowerRow({
      drepId: 'drep1abc',
      epochNo: 515,
      amount: '1',
      capturedAt: new Date(nowMs).toISOString(),
      nowMs,
    });

    expect(row.SK).toBe('POWER#000515');
    // Explicit guard against PROFILE collision: a future refactor that
    // accidentally swapped the prefix would expire DRep directory rows.
    expect(row.SK).not.toBe('PROFILE');
    expect(row.SK.startsWith('POWER#')).toBe(true);
  });

  it('carries the canonical row shape (drepId, SK, epochNo, amount, capturedAt, ttl)', async () => {
    const nowMs = Date.UTC(2026, 4, 27, 0, 0, 0);
    const capturedAt = new Date(nowMs).toISOString();
    const row = buildPowerRow({
      drepId: 'drep1canonicalshape',
      epochNo: 515,
      amount: '9999999999',
      capturedAt,
      nowMs,
    });

    expect(row).toEqual({
      drepId: 'drep1canonicalshape',
      SK: 'POWER#000515',
      epochNo: 515,
      amount: '9999999999',
      capturedAt,
      ttl: Math.floor(nowMs / 1000) + ONE_YEAR_SECONDS,
    });
  });
});
