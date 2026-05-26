/**
 * Regression tests for the DRep directory list handler — specifically
 * the FilterExpression builder.
 *
 * # The bug history this guards against
 *
 * ## 2026-05-17 (Phase C) — POWER rows leak into the listing
 *
 * The `drep_directory` DynamoDB table was originally one-row-per-DRep
 * with `SK='PROFILE'`. Phase C added the `drep-voting-power-history`
 * daily sync, which writes `SK='POWER#NNNNNN'` sub-rows under the same
 * `drepId` partition for the per-DRep sparkline data.
 *
 * The list handler's Scan was not filtered by SK. POWER rows leaked into
 * the listing — the frontend rendered cards with no `givenName` /
 * `isActive` / etc., and `total` was wildly inflated.
 *
 * Fix at the time: a `SK = 'PROFILE'` clause on the Scan's FilterExpression.
 *
 * ## 2026-05-26 — Scan read-side budget exhausts before reaching all PROFILE rows
 *
 * The compound table now holds 1623 PROFILE rows alongside ~100k POWER
 * rows. The Scan with FilterExpression pays for reading every POWER row
 * off disk before the filter selects PROFILE rows out. Empirically the
 * Scan was exhausting its 50k raw-item ceiling and returning only ~800
 * of 1623 PROFILE rows — DReps were missing from the directory listing
 * entirely. Also: the two predefined DReps (`drep_always_abstain` /
 * `drep_always_no_confidence`) — which hold ~9B ADA between them — were
 * explicitly filtered out of the sync.
 *
 * Fix:
 *   - Read path: switched from Scan-with-filter to Query against a new
 *     sparse `entityType-votingPower-index` GSI. The GSI is partitioned
 *     on a constant `entityType='DREP_PROFILE'` attribute that the sync
 *     writes ONLY on PROFILE rows; POWER rows are excluded automatically
 *     by sparseness. The Query is O(PROFILE rows) not O(table size).
 *   - As a consequence, the `SK = 'PROFILE'` clause in the FilterExpression
 *     is no longer needed (and no longer present) — the GSI handles it.
 *   - Sync injects the predefined DReps as synthesized PROFILE rows with
 *     hardcoded display names + `isPredefined=true`.
 *
 * # Coverage
 *
 * The pure `buildDirectoryListFilter` function is tested directly. The
 * handler's Query loop is exercised by the new `queryAllMatching` /
 * regression-row-count test in `list.queryPath.test.ts`.
 *
 * Guarantees we lock in here:
 *   1. The FilterExpression NEVER carries `SK = 'PROFILE'` anymore —
 *      that's the GSI's job. A regression to a Scan-based filter would
 *      reintroduce the POWER-rows-mixing bug AND the row-budget bug.
 *   2. `includeInactive=false` keeps the `isActive=true` + `isRetired`
 *      exclusion filters intact.
 *   3. `search` filter works alongside the active filters.
 *   4. With no filters (`includeInactive=true`, no `search`) the filter
 *      expression is empty so the handler skips passing it to Query
 *      (an empty FilterExpression is a DynamoDB error).
 */

import { describe, it, expect } from 'vitest';
import { buildDirectoryListFilter } from './list';

describe('buildDirectoryListFilter', () => {
  it('returns an empty FilterExpression when no filters apply (includeInactive=true, no search)', () => {
    const result = buildDirectoryListFilter({ includeInactive: true, search: undefined });

    // No filter conditions: the new Query-against-GSI path uses the
    // sparse `entityType` partition key to scope to PROFILE rows; nothing
    // else needs filtering when both toggles are off. The empty string
    // is the signal to the handler to skip passing FilterExpression to
    // Query (DynamoDB rejects an empty FilterExpression).
    expect(result.filterExpression).toBe('');
    expect(result.expressionAttributeNames).toEqual({});
    expect(result.expressionAttributeValues).toEqual({});
  });

  it('NEVER carries a SK="PROFILE" clause in the FilterExpression', () => {
    // The previous bug-fix added `SK = :profileSK` to every code path.
    // The 2026-05-26 GSI migration removes that clause (the GSI is
    // partitioned on `entityType` which is only present on PROFILE
    // rows). If someone re-adds the clause without thinking, they
    // signal that the GSI assumption is broken and we'd want to know
    // about it — this assertion is the canary.
    const variants = [
      buildDirectoryListFilter({ includeInactive: true, search: undefined }),
      buildDirectoryListFilter({ includeInactive: false, search: undefined }),
      buildDirectoryListFilter({ includeInactive: true, search: 'foo' }),
      buildDirectoryListFilter({ includeInactive: false, search: 'foo' }),
    ];
    for (const v of variants) {
      expect(v.filterExpression).not.toContain('SK');
      expect(v.expressionAttributeNames).not.toHaveProperty('#SK');
      expect(v.expressionAttributeValues).not.toHaveProperty(':profileSK');
    }
  });

  it('adds isActive=true + isRetired exclusion on the default view (includeInactive=false)', () => {
    const result = buildDirectoryListFilter({ includeInactive: false, search: undefined });

    expect(result.filterExpression).toContain('#isActive = :true');
    expect(result.filterExpression).toContain(
      '(attribute_not_exists(#isRetired) OR #isRetired = :false)',
    );

    expect(result.expressionAttributeNames).toMatchObject({
      '#isActive': 'isActive',
      '#isRetired': 'isRetired',
    });
    expect(result.expressionAttributeValues).toMatchObject({
      ':true': true,
      ':false': false,
    });
  });

  it('adds search filter when search is provided', () => {
    const result = buildDirectoryListFilter({ includeInactive: true, search: 'Yoroi' });

    expect(result.filterExpression).toContain('contains(#givenNameLower, :q)');
    expect(result.expressionAttributeNames['#givenNameLower']).toBe('givenNameLower');
    expect(result.expressionAttributeValues[':q']).toBe('yoroi');
  });

  it('combines isActive + isRetired + search when all are set', () => {
    const result = buildDirectoryListFilter({ includeInactive: false, search: 'Cardano' });

    expect(result.filterExpression).toContain('#isActive = :true');
    expect(result.filterExpression).toContain(
      '(attribute_not_exists(#isRetired) OR #isRetired = :false)',
    );
    expect(result.filterExpression).toContain('contains(#givenNameLower, :q)');
    expect(result.filterExpression).toMatch(
      /^#isActive = :true AND \(attribute_not_exists\(#isRetired\) OR #isRetired = :false\) AND contains\(#givenNameLower, :q\)$/,
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
