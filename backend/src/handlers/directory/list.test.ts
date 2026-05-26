/**
 * Regression tests for the DRep directory list handler — specifically
 * the FilterExpression builder.
 *
 * # The bug this guards against (2026-05-26)
 *
 * The `drep_directory` DynamoDB table was originally one-row-per-DRep
 * with `SK='PROFILE'`. Phase C (2026-05-17) added the
 * `drep-voting-power-history` daily sync, which writes `SK='POWER#NNNNNN'`
 * sub-rows under the same `drepId` partition for the sparkline data on
 * the per-DRep detail page.
 *
 * The list handler's Scan was not filtered by SK. Result:
 *
 *   - `?includeInactive=true` returned every POWER row mixed in with the
 *     DRep profiles. Each DRep appeared ~6x today (1 PROFILE + ~5 POWER
 *     rows for the epochs since CIP-1694 went live). The `total` field
 *     in the response was wildly inflated and the frontend rendered
 *     cards with no `givenName` / `isActive` / etc.
 *
 *   - `?includeInactive=false` filtered out POWER rows (they don't have
 *     `isActive=true`) but the Scan's 10k-raw-item ceiling (50 rounds ×
 *     200 items) was being burned reading POWER rows from disk, so only
 *     a small fraction of PROFILE rows survived to the filter step.
 *     Mainnet showed only ~33 active DReps when Koios reported ~270.
 *
 * # Coverage
 *
 * The pure `buildDirectoryListFilter` function is tested directly. The
 * handler's Scan loop is straightforward pagination — exercising it
 * end-to-end would require mocking DynamoDB, which adds setup complexity
 * for zero behavioral coverage beyond what the unit-level helper gives.
 *
 * Three guarantees we want to lock in:
 *   1. EVERY query has `SK = :profileSK` in its FilterExpression — no
 *      future change can accidentally remove that.
 *   2. `includeInactive=false` keeps the `isActive=true` filter +
 *      `isRetired` exclusion as before.
 *   3. `search` filter still works alongside the PROFILE+active filters.
 */

import { describe, it, expect } from 'vitest';
import { buildDirectoryListFilter } from './list';

describe('buildDirectoryListFilter', () => {
  it('always restricts to SK=PROFILE, even with no other filters', () => {
    const result = buildDirectoryListFilter({ includeInactive: true, search: undefined });

    // The SK filter MUST be in the expression — its absence is the
    // root cause of the "POWER rows leaking into the directory" bug.
    expect(result.filterExpression).toContain('#SK = :profileSK');
    expect(result.expressionAttributeNames['#SK']).toBe('SK');
    expect(result.expressionAttributeValues[':profileSK']).toBe('PROFILE');

    // With `includeInactive=true` no other conditions are added — the
    // SK-only filter is the entire expression.
    expect(result.filterExpression).toBe('#SK = :profileSK');
  });

  it('combines SK=PROFILE with isActive=true + isRetired exclusion on the default view', () => {
    const result = buildDirectoryListFilter({ includeInactive: false, search: undefined });

    // SK filter still present — regression guard for the bug above.
    expect(result.filterExpression).toContain('#SK = :profileSK');

    // Active-only filters layered on top, AND-joined.
    expect(result.filterExpression).toContain('#isActive = :true');
    expect(result.filterExpression).toContain(
      '(attribute_not_exists(#isRetired) OR #isRetired = :false)',
    );

    // Conditions are joined with ' AND '.
    expect(result.filterExpression).toMatch(/ AND /);

    // Attribute name / value bindings cover everything referenced.
    expect(result.expressionAttributeNames).toMatchObject({
      '#SK': 'SK',
      '#isActive': 'isActive',
      '#isRetired': 'isRetired',
    });
    expect(result.expressionAttributeValues).toMatchObject({
      ':profileSK': 'PROFILE',
      ':true': true,
      ':false': false,
    });
  });

  it('combines SK=PROFILE with search filter when search is provided', () => {
    const result = buildDirectoryListFilter({ includeInactive: true, search: 'Yoroi' });

    // SK filter present.
    expect(result.filterExpression).toContain('#SK = :profileSK');
    // Search filter present, lowercased (the directory stores
    // `givenNameLower` for case-insensitive contains).
    expect(result.filterExpression).toContain('contains(#givenNameLower, :q)');
    expect(result.expressionAttributeNames['#givenNameLower']).toBe('givenNameLower');
    expect(result.expressionAttributeValues[':q']).toBe('yoroi');
  });

  it('combines all three filter layers when both flags are set', () => {
    const result = buildDirectoryListFilter({ includeInactive: false, search: 'Cardano' });

    expect(result.filterExpression).toContain('#SK = :profileSK');
    expect(result.filterExpression).toContain('#isActive = :true');
    expect(result.filterExpression).toContain('contains(#givenNameLower, :q)');
    // The order in the joined string is deterministic — SK first
    // (cheapest selectivity), then isActive/isRetired, then search.
    // This ordering is documentation-only (DynamoDB doesn't care) but
    // a regression in ordering would suggest someone moved conditions
    // around without thinking about why.
    expect(result.filterExpression).toMatch(
      /#SK = :profileSK AND #isActive = :true AND \(attribute_not_exists\(#isRetired\) OR #isRetired = :false\) AND contains\(#givenNameLower, :q\)/,
    );
  });

  it('lowercases the search term for case-insensitive matching', () => {
    const r1 = buildDirectoryListFilter({ includeInactive: true, search: 'YOROI' });
    const r2 = buildDirectoryListFilter({ includeInactive: true, search: 'yoroi' });
    const r3 = buildDirectoryListFilter({ includeInactive: true, search: 'YoRoI' });

    expect(r1.expressionAttributeValues[':q']).toBe('yoroi');
    expect(r2.expressionAttributeValues[':q']).toBe('yoroi');
    expect(r3.expressionAttributeValues[':q']).toBe('yoroi');
  });
});
