/**
 * Tests for the shared `audit_log` writer (`lib/audit.ts`).
 *
 * # What we lock in
 *
 *   1. Wire shape — `pk` = `entityType#entityId`, `sk` =
 *      `timestamp#eventType`, `ttl` = `floor(nowSec) + 365d`.
 *   2. Best-effort guarantee — an exception thrown by the underlying
 *      `putItem` does NOT propagate to the caller. This is the
 *      load-bearing invariant: an audit-write failure must NEVER
 *      take down the mutation it's auditing.
 *   3. Metadata pass-through — present when provided, absent otherwise.
 *   4. Default `now` — when no Date is injected, the helper uses
 *      `new Date()` and the resulting `ttl` lands near `now + 365d`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./dynamodb', () => ({
  putItem: vi.fn(),
  tableNames: {
    auditLog: 'test-audit_log',
  },
}));

import { putItem } from './dynamodb';
import { buildAuditRow, writeAuditEvent, auditTtlForDate } from './audit';

const mockPut = vi.mocked(putItem);

beforeEach(() => {
  vi.resetAllMocks();
  mockPut.mockResolvedValue(undefined);
});

describe('buildAuditRow — pure key shape', () => {
  it('composes pk as entityType#entityId', () => {
    const row = buildAuditRow(
      {
        entityType: 'comment',
        entityId: 'cmt_01ABC',
        eventType: 'comment.created',
        actorWallet: 'stake1ualice',
      },
      new Date('2026-05-28T12:00:00.000Z'),
    );
    expect(row.pk).toBe('comment#cmt_01ABC');
  });

  it('composes sk as timestamp#eventType, ISO-8601 first so it sorts chronologically', () => {
    const row = buildAuditRow(
      {
        entityType: 'comment',
        entityId: 'cmt_01ABC',
        eventType: 'comment.deleted',
        actorWallet: 'stake1ualice',
      },
      new Date('2026-05-28T12:00:00.000Z'),
    );
    expect(row.sk).toBe('2026-05-28T12:00:00.000Z#comment.deleted');
    // The lexicographic compare on ISO-8601 IS chronological, so a
    // Query(pk) with ScanIndexForward=true returns events oldest-first.
    expect(row.sk.split('#')[0]).toBe(row.timestamp);
  });

  it('sets ttl to now-in-seconds + 365 days', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const row = buildAuditRow(
      {
        entityType: 'auth',
        entityId: 'stake1ualice',
        eventType: 'auth.login',
        actorWallet: 'stake1ualice',
      },
      now,
    );
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(row.ttl).toBe(nowSec + 365 * 24 * 60 * 60);
    // Verify against the exported helper too — same math, exported for
    // callers that want to assert the TTL without reading a row.
    expect(row.ttl).toBe(auditTtlForDate(now));
  });

  it('preserves entityType / entityId / eventType / actorWallet / timestamp on the row', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const row = buildAuditRow(
      {
        entityType: 'clubhouse_post',
        entityId: 'post_01XYZ',
        eventType: 'clubhouse.post.deleted',
        actorWallet: 'stake1ualice',
      },
      now,
    );
    expect(row).toMatchObject({
      entityType: 'clubhouse_post',
      entityId: 'post_01XYZ',
      eventType: 'clubhouse.post.deleted',
      actorWallet: 'stake1ualice',
      timestamp: '2026-05-28T12:00:00.000Z',
    });
  });

  it('omits metadata key when input.metadata is undefined', () => {
    const row = buildAuditRow(
      {
        entityType: 'comment',
        entityId: 'cmt_01ABC',
        eventType: 'comment.created',
        actorWallet: 'stake1ualice',
      },
      new Date('2026-05-28T12:00:00.000Z'),
    );
    expect(Object.prototype.hasOwnProperty.call(row, 'metadata')).toBe(false);
  });

  it('passes metadata through verbatim when supplied', () => {
    const row = buildAuditRow(
      {
        entityType: 'comment',
        entityId: 'cmt_01ABC',
        eventType: 'comment.voted',
        actorWallet: 'stake1uvoter',
        metadata: { actionId: 'tx#0', voteDirection: 'up' },
      },
      new Date('2026-05-28T12:00:00.000Z'),
    );
    expect(row.metadata).toEqual({ actionId: 'tx#0', voteDirection: 'up' });
  });
});

describe('writeAuditEvent — best-effort guarantee', () => {
  it('writes to the audit_log table with the composed row shape', async () => {
    await writeAuditEvent({
      entityType: 'comment',
      entityId: 'cmt_01ABC',
      eventType: 'comment.created',
      actorWallet: 'stake1ualice',
      metadata: { actionId: 'tx#0' },
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    const [table, item] = mockPut.mock.calls[0]!;
    expect(table).toBe('test-audit_log');
    const row = item as Record<string, unknown>;
    expect(row['pk']).toBe('comment#cmt_01ABC');
    expect(typeof row['sk']).toBe('string');
    expect((row['sk'] as string).endsWith('#comment.created')).toBe(true);
    expect(row['actorWallet']).toBe('stake1ualice');
    expect(row['metadata']).toEqual({ actionId: 'tx#0' });
    expect(typeof row['ttl']).toBe('number');
  });

  it('CRITICAL: returns void without throwing when putItem rejects (best-effort guarantee)', async () => {
    // This is THE test that proves the invariant: a thrown error from
    // the audit write must NOT change the handler's success response.
    // If this test ever flakes back to expecting a rejection, an
    // entire class of governance-platform mutations becomes
    // takedown-able via DDB partition throttling.
    mockPut.mockRejectedValue(new Error('throttled by DynamoDB'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // No `expect(...).rejects` — the helper must resolve.
    await expect(
      writeAuditEvent({
        entityType: 'comment',
        entityId: 'cmt_01ABC',
        eventType: 'comment.created',
        actorWallet: 'stake1ualice',
      }),
    ).resolves.toBeUndefined();

    // The failure is observable via console.warn (CloudWatch will
    // surface it) but never propagates to the caller.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('best-effort against non-Error throwables too (defensive)', async () => {
    // putItem could in theory reject with a non-Error value (e.g. a
    // bare string from a custom rejection). The helper must catch
    // that too — `catch (err)` matches anything.
    mockPut.mockRejectedValue('upstream string rejection');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      writeAuditEvent({
        entityType: 'auth',
        entityId: 'stake1ualice',
        eventType: 'auth.login',
        actorWallet: 'stake1ualice',
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('uses now() when no Date is injected (TTL lands inside ±5s of expected)', async () => {
    const before = Math.floor(Date.now() / 1000);
    await writeAuditEvent({
      entityType: 'profile',
      entityId: 'stake1ualice',
      eventType: 'profile.updated',
      actorWallet: 'stake1ualice',
    });
    const after = Math.floor(Date.now() / 1000);
    const [, item] = mockPut.mock.calls[0]!;
    const ttl = (item as Record<string, unknown>)['ttl'] as number;
    const oneYearSec = 365 * 24 * 60 * 60;
    expect(ttl).toBeGreaterThanOrEqual(before + oneYearSec);
    expect(ttl).toBeLessThanOrEqual(after + oneYearSec + 5);
  });
});
