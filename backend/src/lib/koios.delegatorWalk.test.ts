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
// Predefined-DRep delegator walk (Batch F #10, 2026-05-27)
// ============================================================
//
// The predefined DReps (Always Abstain, Always No Confidence) hold most
// of mainnet's voting power and have correspondingly large delegator
// pools — Abstain alone is in the ~60k range. The per-request walk
// (1000-row cap above) would always return "1000+" which is useless,
// so the directory sync owns a separate walk path with a 100-page cap
// (~100k rows). Same result shape as the per-request walk; the higher
// cap is the only material difference.

describe('fetchPredefinedDRepDelegatorCount — sync-time walk', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the exact count when the upstream has fewer than 100k delegators', async () => {
    // 5500 rows total — 5 full pages + a short page. Walk completes
    // naturally; isApprox=false because we saw the short-page signal.
    mockKoiosPages([1000, 1000, 1000, 1000, 1000, 500]);

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toEqual({ count: 5500, isApprox: false });
    // Six pages consumed (5 full + 1 short).
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
  });

  it('returns isApprox=true at the 100-page hard cap', async () => {
    // 100 full pages — never sees a short page. Walk stops at the cap.
    // This is the "Abstain has > 100k delegators" path.
    mockKoiosPages(Array.from({ length: 100 }, () => 1000));

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toEqual({ count: 100000, isApprox: true });
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(100);
  });

  it('returns null when the very first page fails entirely (preserve prior cycle)', async () => {
    // First-page total failure — caller treats null as "preserve the
    // previous cycle's count" rather than clobbering with undefined.
    globalThis.fetch = vi.fn(async () =>
      new Response('Service Unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      }),
    ) as unknown as typeof fetch;

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toBeNull();
  });

  it('returns the partial count with isApprox=true when a mid-walk page fails', async () => {
    // First 3 pages succeed (3000 rows), then a 503 on page 4. The
    // caller still gets useful data — "at least 3000" is better than
    // pretending the walk never started.
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call <= 3) {
        const rows = Array.from({ length: 1000 }, () => ({
          stake_address: 'stake1xxx',
          amount: '1',
        }));
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Internal Server Error', { status: 500 });
    }) as unknown as typeof fetch;

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toEqual({ count: 3000, isApprox: true });
  });

  it('returns isApprox=true on a malformed mid-walk response (parse failure)', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        const rows = Array.from({ length: 1000 }, () => ({
          stake_address: 'stake1xxx',
          amount: '1',
        }));
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Second page: malformed JSON.
      return new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await fetchPredefinedDRepDelegatorCount('drep_always_abstain');

    expect(result).toEqual({ count: 1000, isApprox: true });
  });
});
