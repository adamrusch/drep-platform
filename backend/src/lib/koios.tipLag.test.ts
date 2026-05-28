/**
 * Tests for the Koios db-sync staleness check added 2026-05-28.
 *
 * The check piggybacks on the existing `/tip` call that every sync
 * already makes: we read the tip block's `block_time` and compare it to
 * wall-clock. If the gap exceeds `KOIOS_TIP_LAG_THRESHOLD_SEC` (5 min),
 * `getCurrentTip` emits a structured `[Koios tip lag]` warning that a
 * CloudWatch metric filter / alarm can latch onto, and the returned
 * `lagSec` lets the caller decorate its own result/log shape with the
 * forensic value.
 *
 * What we lock in:
 *
 *   1. The pure lag computation (`computeTipLagSec`) handles a fresh
 *      tip (0 lag), a 10-min-old tip (flagged), clock skew (clamped to
 *      0), and non-finite inputs (defensively returns 0).
 *   2. `getCurrentTip` returns the expected shape on a fresh tip and
 *      does NOT emit the structured warning.
 *   3. `getCurrentTip` on a 10-min-old tip returns `isStale: true` AND
 *      emits a single `[Koios tip lag]` console.warn that includes
 *      `lagSec=`, `thresholdSec=`, `blockTime=`, `epochNo=` keys (the
 *      metric-filter contract).
 *   4. `getCurrentEpoch` (the back-compat wrapper) returns the same
 *      epoch number `getCurrentTip` does, and the staleness check
 *      fires under it too.
 *   5. The tip cache de-duplicates calls within `TIP_CACHE_TTL_MS` —
 *      important for the warning hygiene (we don't want to spam the
 *      log on every warm-Lambda call).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  KOIOS_TIP_LAG_THRESHOLD_SEC,
  computeTipLagSec,
  getCurrentEpoch,
  getCurrentTip,
  _resetCache,
} from './koios';

/** Build a fetch mock that returns a single `/tip` row with the given
 *  `block_time`. Always responds with epoch_no=633 for stability. */
function mockTipResponse(blockTime: number): ReturnType<typeof vi.fn> {
  const row = {
    hash: 'abc',
    epoch_no: 633,
    era: 'Conway',
    abs_slot: 1,
    epoch_slot: 1,
    block_height: 1,
    block_no: 1,
    block_time: blockTime,
  };
  const mock = vi.fn(async () =>
    new Response(JSON.stringify([row]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('computeTipLagSec — pure function', () => {
  it('returns 0 for a tip whose block_time matches wall clock', () => {
    const now = 1_780_006_795 * 1000;
    expect(computeTipLagSec(1_780_006_795, now)).toBe(0);
  });

  it('returns the positive lag in seconds for an older tip', () => {
    // Wall clock is 10 minutes ahead of the tip block. That's 600s of lag.
    const tipSec = 1_780_000_000;
    const nowMs = (tipSec + 600) * 1000;
    expect(computeTipLagSec(tipSec, nowMs)).toBe(600);
  });

  it('clamps a "future" tip (clock skew) to zero', () => {
    // Tip block is 30s in the future (Lambda clock is behind the
    // Cardano network). Lag must clamp to 0 — we never report
    // negative values that would confuse a metric filter.
    const tipSec = 1_780_000_030;
    const nowMs = 1_780_000_000 * 1000;
    expect(computeTipLagSec(tipSec, nowMs)).toBe(0);
  });

  it('returns 0 for non-finite block_time (defensive)', () => {
    expect(computeTipLagSec(NaN, Date.now())).toBe(0);
    expect(computeTipLagSec(Infinity, Date.now())).toBe(0);
  });

  it('returns 0 for non-finite nowMs (defensive)', () => {
    expect(computeTipLagSec(1_780_000_000, NaN)).toBe(0);
  });

  it('threshold constant is 5 minutes', () => {
    // The product threshold is 5 min. Lock in the constant so a
    // refactor doesn't silently drift it.
    expect(KOIOS_TIP_LAG_THRESHOLD_SEC).toBe(300);
  });
});

describe('getCurrentTip — fresh tip', () => {
  const originalFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it('returns isStale=false when the tip matches wall clock', async () => {
    const nowMs = Date.now();
    const tipSec = Math.floor(nowMs / 1000);
    mockTipResponse(tipSec);

    const info = await getCurrentTip();

    expect(info.epochNo).toBe(633);
    expect(info.blockTime).toBe(tipSec);
    expect(info.lagSec).toBeLessThanOrEqual(1); // Allow one second of drift.
    expect(info.isStale).toBe(false);
    // No staleness warning on a healthy tip.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns isStale=false for a 2-minute lag (within tolerance)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockTipResponse(nowSec - 120);

    const info = await getCurrentTip();

    expect(info.lagSec).toBeGreaterThanOrEqual(120);
    expect(info.lagSec).toBeLessThan(125);
    expect(info.isStale).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('getCurrentTip — stale tip', () => {
  const originalFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it('flags a 10-minute-old tip as stale and emits the [Koios tip lag] warning', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // 10 minutes back — well past the 5-minute threshold.
    mockTipResponse(nowSec - 600);

    const info = await getCurrentTip();

    expect(info.lagSec).toBeGreaterThanOrEqual(600);
    expect(info.isStale).toBe(true);
    // Exactly ONE structured warning emitted on the cold-cache fetch.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]![0] as string;
    // Metric-filter contract: literal prefix + key=value fields.
    expect(line).toContain('[Koios tip lag]');
    expect(line).toMatch(/lagSec=\d+/);
    expect(line).toContain(`thresholdSec=${KOIOS_TIP_LAG_THRESHOLD_SEC}`);
    expect(line).toMatch(/blockTime=\d+/);
    expect(line).toMatch(/epochNo=\d+/);
  });

  it('does NOT re-emit the warning on warm-cache hits within the 30s TTL', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockTipResponse(nowSec - 900); // 15 min stale

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await getCurrentTip();
    await getCurrentTip();
    await getCurrentTip();

    // Warning fires only on the first (cold-cache) call. Subsequent
    // calls hit the cache and produce no new warning.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Only one HTTP round-trip too — confirms the cache short-circuit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getCurrentEpoch — back-compat wrapper', () => {
  const originalFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it('returns the epoch number directly', async () => {
    mockTipResponse(Math.floor(Date.now() / 1000));

    const epoch = await getCurrentEpoch();

    expect(epoch).toBe(633);
  });

  it('still emits the staleness warning when called via the back-compat path', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockTipResponse(nowSec - 1200); // 20 min stale

    await getCurrentEpoch();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect((warnSpy.mock.calls[0]![0] as string)).toContain('[Koios tip lag]');
  });
});

describe('getCurrentTip — error paths', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws KoiosError on missing block_time field (defensive — should never happen)', async () => {
    const row = { epoch_no: 633 }; // No block_time.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([row]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    await expect(getCurrentTip()).rejects.toThrow('missing block_time');
  });

  it('throws KoiosError on 5xx upstream failure', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }),
    ) as unknown as typeof fetch;

    await expect(getCurrentTip()).rejects.toThrow('HTTP 503');
  });
});
