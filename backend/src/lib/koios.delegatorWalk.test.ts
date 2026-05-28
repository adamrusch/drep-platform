/**
 * Regression tests for `fetchDRepDelegatorCount`'s walk cap (2026-05-27).
 *
 * # The bug this guards against
 *
 * The original implementation used a 5-page cap (PAGE_SIZE × 5 = 5000
 * rows). On the largest non-predefined DReps, walking that many pages
 * stretched wall-clock to ~30-40s — too close to the API Lambda's 30s
 * timeout — and as the directory grows organically, more DReps will
 * cross the threshold. We capped the walk at 1000 rows (one Koios
 * round-trip), made the cap env-overridable (`MAX_DELEGATORS_WALK`),
 * and renamed the surfaced flag from `truncated` to `isApprox` so the
 * "≥ count, not less" contract is clearer.
 *
 * # What we lock in
 *
 *   1. A walk that fills the 1000-row default cap on page 0 stops
 *      immediately and reports `isApprox: true`.
 *   2. A walk that finishes naturally below the cap reports the exact
 *      count with `isApprox: false`.
 *   3. The env override `MAX_DELEGATORS_WALK` is honored when set to a
 *      positive integer; invalid values fall back to the default.
 *   4. Predefined DReps continue to be short-circuited by the calling
 *      handler (`directory/get.ts`) — this is verified at the handler
 *      level by inspection of `cached.isPredefined ? skip : walk`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchDRepDelegatorCount, fetchPredefinedDRepDelegatorCount } from './koios';

const DREP = 'drep1testfixture';

/** Build a fetch mock that returns successive pages from `pages`, each
 *  page an array of plausible KoiosDRepDelegator rows. A request past the
 *  end of `pages` returns an empty array (PostgREST's "no more rows"
 *  signal). */
function mockKoiosPages(pages: number[]): void {
  const responses = pages.map((rowCount) =>
    Array.from({ length: rowCount }, (_, i) => ({
      stake_address: `stake1_${i}`,
      amount: '1000000',
    })),
  );
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const body = responses[call] ?? [];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

describe('fetchDRepDelegatorCount — walk cap', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env['MAX_DELEGATORS_WALK'];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('stops at the 1000-row default cap and reports isApprox=true on a popular DRep', async () => {
    // Mainnet shape: a single Koios page is 1000 rows. Hitting the cap
    // on page 0 means we walked ONE round-trip — the design goal of the
    // 2026-05-27 cap change.
    mockKoiosPages([1000, 1000, 1000, 500]); // upstream has 3500 rows

    const result = await fetchDRepDelegatorCount(DREP);

    expect(result).toEqual({ count: 1000, isApprox: true });
    // Only ONE Koios round-trip on the popular path — the cap fires
    // BEFORE the second page is requested.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('returns the exact count when the walk finishes naturally below the cap', async () => {
    // 800 rows on page 0 (less than PAGE_SIZE=1000) — PostgREST's short-
    // page signal means "no more rows upstream." We stop and report
    // the exact count.
    mockKoiosPages([800]);

    const result = await fetchDRepDelegatorCount(DREP);

    expect(result).toEqual({ count: 800, isApprox: false });
  });

  it('returns 0 rows + isApprox=false for an undelegated DRep', async () => {
    mockKoiosPages([0]);

    const result = await fetchDRepDelegatorCount(DREP);

    expect(result).toEqual({ count: 0, isApprox: false });
  });

  it('honors the MAX_DELEGATORS_WALK env override (positive integer)', async () => {
    // Bump the cap to 2500 — the walk should now consume up to 2500
    // rows (3 page reads, last one short of the cap).
    process.env['MAX_DELEGATORS_WALK'] = '2500';
    mockKoiosPages([1000, 1000, 1000, 500]);

    const result = await fetchDRepDelegatorCount(DREP);

    // After page 0 (count=1000) and page 1 (count=2000), neither has
    // crossed 2500 so the walk continues. After page 2 (count=3000),
    // count >= 2500 triggers the stop with isApprox=true.
    expect(result).toEqual({ count: 3000, isApprox: true });
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it('falls back to the default cap when MAX_DELEGATORS_WALK is non-numeric', async () => {
    process.env['MAX_DELEGATORS_WALK'] = 'oops';
    mockKoiosPages([1000, 1000, 200]);

    const result = await fetchDRepDelegatorCount(DREP);

    // Garbage value → default 1000 → cap fires after page 0.
    expect(result).toEqual({ count: 1000, isApprox: true });
  });

  it('falls back to the default cap when MAX_DELEGATORS_WALK is zero', async () => {
    process.env['MAX_DELEGATORS_WALK'] = '0';
    mockKoiosPages([1000, 1000, 200]);

    const result = await fetchDRepDelegatorCount(DREP);

    expect(result).toEqual({ count: 1000, isApprox: true });
  });
});

// ============================================================
// Predefined-DRep delegator count via PostgREST count=exact
// (Item DATA-1, 2026-05-28)
// ============================================================
//
// The predefined DReps (Always Abstain, Always No Confidence) hold most
// of mainnet's voting power and have correspondingly large delegator
// pools — Abstain was 181,308 on 2026-05-28 (still growing). An earlier
// revision walked `/drep_delegators` 100 pages × 1000 rows = up to 100k
// rows per cycle, which (a) underestimated by ~80k, and (b) routinely
// timed out the 5-min directory-sync Lambda. The new path issues ONE
// request with `Prefer: count=exact` + `Range: 0-0` and reads the
// exact total off the `Content-Range` response header. Sub-second,
// always precise — no walk, no cap.

import { parseContentRangeTotal } from './koios';

/** Build a single Response with the given `content-range` header and an
 *  empty (or trivially short) row body. Returns a fetch-mock that always
 *  responds with this single response, no matter the request URL. */
function mockCountExactResponse(opts: {
  status?: number;
  contentRange?: string | null;
  body?: string;
}): void {
  const status = opts.status ?? 206;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.contentRange != null) headers['Content-Range'] = opts.contentRange;
  globalThis.fetch = vi.fn(
    async () => new Response(opts.body ?? '[]', { status, headers }),
  ) as unknown as typeof fetch;
}

describe('fetchPredefinedDRepDelegatorCount — count=exact path', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the exact total parsed from Content-Range and isApprox=false', async () => {
    // Mainnet shape on 2026-05-28: drep_always_abstain reports
    // "content-range: 0-0/181308" to a single Range:0-0 request with
    // Prefer: count=exact.
    mockCountExactResponse({ contentRange: '0-0/181308' });

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toEqual({ count: 181308, isApprox: false });
    // Exactly ONE Koios round-trip. The whole point of this path is
    // replacing the 100-page walk with a single header read.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('forwards Prefer: count=exact and Range: 0-0 on the request', async () => {
    mockCountExactResponse({ contentRange: '0-0/6915' });

    await fetchPredefinedDRepDelegatorCount('drep_always_no_confidence');

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Prefer')).toBe('count=exact');
    expect(headers.get('Range')).toBe('0-0');
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({ _drep_id: 'drep_always_no_confidence' });
  });

  it('handles a count=exact reply with zero delegators', async () => {
    mockCountExactResponse({ contentRange: '*/0' });

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toEqual({ count: 0, isApprox: false });
  });

  it('returns null on a 5xx upstream failure (preserve prior cycle)', async () => {
    // 5xx → caller treats null as "preserve the previous cycle's
    // count" rather than clobbering with undefined.
    mockCountExactResponse({ status: 503, contentRange: null, body: 'Service Unavailable' });

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toBeNull();
  });

  it('returns null on a network failure (transport error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toBeNull();
  });

  it('returns null when Content-Range is missing entirely', async () => {
    // Some upstream proxies strip non-standard headers. We refuse to
    // synthesize a fake count from `0` rows — better to preserve the
    // prior cycle than persist a misleading zero.
    mockCountExactResponse({ contentRange: null });

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toBeNull();
  });

  it('returns null when Content-Range total is unparseable', async () => {
    mockCountExactResponse({ contentRange: '0-0/not-a-number' });

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toBeNull();
  });
});

describe('parseContentRangeTotal — header parser', () => {
  it('parses the standard 0-0/<n> format', () => {
    expect(parseContentRangeTotal('0-0/181308')).toBe(181308);
  });

  it('parses 0-999/<n> (a full first page)', () => {
    expect(parseContentRangeTotal('0-999/1234567')).toBe(1234567);
  });

  it('parses */0 (PostgREST "no rows" shape)', () => {
    expect(parseContentRangeTotal('*/0')).toBe(0);
  });

  it('returns null for null/undefined/empty input', () => {
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
  });

  it('returns null when the total slot is `*` (server declined to count)', () => {
    expect(parseContentRangeTotal('0-99/*')).toBeNull();
  });

  it('returns null for malformed totals (non-digit characters)', () => {
    expect(parseContentRangeTotal('0-0/abc')).toBeNull();
    expect(parseContentRangeTotal('0-0/12.5')).toBeNull();
    expect(parseContentRangeTotal('0-0/1e5')).toBeNull();
    expect(parseContentRangeTotal('0-0/ ')).toBeNull();
  });

  it('returns null when the `/` separator is absent', () => {
    expect(parseContentRangeTotal('0-99')).toBeNull();
  });

  it('returns null for negative totals (defensive — should never happen)', () => {
    expect(parseContentRangeTotal('0-0/-5')).toBeNull();
  });
});
