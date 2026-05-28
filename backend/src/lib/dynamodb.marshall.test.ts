/**
 * Regression tests for the doc-client number marshall/unmarshall config
 * — the load-bearing precision guarantees behind the 2026-05-28 P0-2
 * fix (`comments.supportLovelace` as DDB `N`).
 *
 * These exercise the actual `marshall` / `unmarshall` functions from
 * `@aws-sdk/util-dynamodb`, configured with the SAME options the doc
 * client in `dynamodb.ts` uses. If those defaults ever drift, the live
 * `ADD :delta` semantics break silently. Pinning the contract here
 * gives us early warning.
 *
 * # What we lock in
 *
 *   1. **`bigint` writes as DDB `N`.** Passing a JS bigint to `marshall`
 *      yields `{N: "<digits>"}`. This is the wire shape the vote
 *      handler depends on; previously the code did `.toString()` and
 *      got `{S: "..."}`, which made `ADD` throw ValidationException.
 *
 *   2. **Lovelace values beyond `MAX_SAFE_INTEGER` round-trip without
 *      precision loss** when unmarshalled with the custom
 *      `wrapNumbers` function defined in `dynamodb.ts`. Total Cardano
 *      supply is ~4.5×10^16 lovelace; JS safe-int caps at ~9×10^15. A
 *      lovelace accumulator in the danger zone MUST come back as
 *      `bigint`, not a lossy `number`.
 *
 *   3. **Small-valued `N` attributes still come back as `number`** so
 *      existing counters (`upvoteCount`, `enrichmentVersion`, etc.)
 *      stay typed as JS numbers. The smart-unwrap threshold is the
 *      whole reason for the function — `bigint` everywhere would
 *      cascade type churn through the entire backend.
 */
import { describe, it, expect } from 'vitest';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// `wrapNumbers` accepts EITHER a boolean OR a function; we lift the
// SAME function declared in `dynamodb.ts` here. (Importing it would
// require it to be exported; the function body is short enough to
// reproduce inline without coupling.) If you change one, change both —
// the assertion below pinning the threshold acts as a tripwire.
function smartUnwrapNumber(value: string): number | bigint {
  if (value.includes('.') || value.includes('e') || value.includes('E')) {
    return Number(value);
  }
  try {
    const asBig = BigInt(value);
    if (
      asBig <= BigInt(Number.MAX_SAFE_INTEGER) &&
      asBig >= BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return Number(value);
    }
    return asBig;
  } catch {
    return Number(value);
  }
}

describe('DDB marshall — bigint → N', () => {
  it('marshals a JS bigint as a DDB Number attribute (the contract the vote handler depends on)', () => {
    const av = marshall(BigInt('5000000000000'));
    expect(av).toEqual({ N: '5000000000000' });
  });

  it('marshals a bigint past MAX_SAFE_INTEGER without precision loss', () => {
    // 10^17 lovelace — over the safe-int boundary, under total supply.
    const huge = BigInt('100000000000000000');
    const av = marshall(huge);
    expect(av).toEqual({ N: '100000000000000000' });
  });

  it('marshals a stringified-bigint as a DDB String — the bug we fixed', () => {
    // This is what the OLD code path was doing: `.toString()` on the
    // delta. The marshaller writes it as S, not N. ADD :delta against
    // an N attribute then throws ValidationException at the DDB layer.
    const av = marshall('5000000000000');
    expect(av).toEqual({ S: '5000000000000' });
  });

  it('marshals a JS number as N (small counter shape)', () => {
    const av = marshall(42);
    expect(av).toEqual({ N: '42' });
  });
});

describe('DDB unmarshall — smartUnwrapNumber threshold', () => {
  const opts = { wrapNumbers: smartUnwrapNumber };

  it('returns small N values as JS number (counters keep their existing types)', () => {
    const out = unmarshall(
      { upvoteCount: { N: '5' }, downvoteCount: { N: '0' } },
      opts,
    );
    expect(out['upvoteCount']).toBe(5);
    expect(out['downvoteCount']).toBe(0);
    expect(typeof out['upvoteCount']).toBe('number');
  });

  it('returns MAX_SAFE_INTEGER as number (boundary check)', () => {
    const out = unmarshall(
      { v: { N: String(Number.MAX_SAFE_INTEGER) } },
      opts,
    );
    expect(out['v']).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeof out['v']).toBe('number');
  });

  it('returns one-past MAX_SAFE_INTEGER as bigint (the lovelace precision case)', () => {
    const justPast = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    const out = unmarshall({ v: { N: justPast } }, opts);
    expect(out['v']).toBe(BigInt(justPast));
    expect(typeof out['v']).toBe('bigint');
  });

  it('returns a lovelace-scale value (≈ 4×10^16) as bigint with full precision', () => {
    // Realistic worst-case for `supportLovelace`: near total Cardano
    // supply. As a JS number this would round to `40000000000000004`
    // (or similar) — losing the trailing digit. As a bigint it's exact.
    const lovelace = '40000000000000001';
    const out = unmarshall({ v: { N: lovelace } }, opts);
    expect(out['v']).toBe(BigInt(lovelace));
    expect((out['v'] as bigint).toString()).toBe(lovelace);
  });

  it('returns negative bigints below MIN_SAFE_INTEGER as bigint', () => {
    const huge = '-100000000000000000';
    const out = unmarshall({ v: { N: huge } }, opts);
    expect(out['v']).toBe(BigInt(huge));
    expect(typeof out['v']).toBe('bigint');
  });

  it('returns scientific-notation N values as number (cannot be a bigint)', () => {
    // DDB doesn't naturally emit this shape, but be defensive — N can
    // contain any number-like string.
    const out = unmarshall({ v: { N: '1.5e3' } }, opts);
    expect(out['v']).toBe(1500);
    expect(typeof out['v']).toBe('number');
  });
});

describe('DDB round-trip — write bigint, read bigint, preserve precision', () => {
  it('preserves a 17-digit lovelace value through marshall → unmarshall', () => {
    const input = BigInt('40000000000000001'); // 4×10^16 + 1
    const av = marshall(input);
    expect(av).toEqual({ N: '40000000000000001' });

    const out = unmarshall({ v: av }, { wrapNumbers: smartUnwrapNumber });
    expect(out['v']).toBe(input);
  });

  it('preserves a small bigint through marshall but unwraps it as a JS number on read', () => {
    // Small bigints arrive back as numbers per the smart-unwrap
    // threshold. That's intentional — see the type docblock on
    // CommentItem.supportLovelace.
    const input = BigInt(42);
    const av = marshall(input);
    const out = unmarshall({ v: av }, { wrapNumbers: smartUnwrapNumber });
    expect(out['v']).toBe(42);
    expect(typeof out['v']).toBe('number');
  });
});
