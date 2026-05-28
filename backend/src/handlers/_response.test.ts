/**
 * Response-helper tests. Specifically guards the BigInt-aware
 * `JSON.stringify` path added for the 2026-05-28 P0-2 fix.
 *
 * After P0-2, DDB Number fields can come back to handlers as JS
 * `bigint` (when their magnitude exceeds `MAX_SAFE_INTEGER`). The
 * built-in `JSON.stringify` throws `TypeError: Do not know how to
 * serialize a BigInt` on these — which would 500 every endpoint
 * returning a comment with a "large" `supportLovelace`. We added a
 * replacer in `_response.ts` that coerces `bigint` to string at the
 * response boundary, matching the wire convention every Cardano API
 * already uses for lovelace.
 *
 * These tests pin that behavior. If the replacer regresses, every
 * comment-listing endpoint silently 500s for popular comments.
 */
import { describe, it, expect } from 'vitest';
import { ok, created } from './_response';

describe('_response BigInt serialization', () => {
  it('ok() emits bigint values as strings (no TypeError)', () => {
    const res = ok({ supportLovelace: BigInt('40000000000000001') });
    expect(res).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((res as { body: string }).body) as {
      data: { supportLovelace: string };
    };
    expect(body.data.supportLovelace).toBe('40000000000000001');
    expect(typeof body.data.supportLovelace).toBe('string');
  });

  it('created() emits bigint values as strings', () => {
    const res = created({
      commentId: 'cmt-1',
      supportLovelace: BigInt('5000000000000'),
    });
    expect(res).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((res as { body: string }).body) as {
      data: { supportLovelace: string };
    };
    expect(body.data.supportLovelace).toBe('5000000000000');
  });

  it('handles nested bigints inside arrays and objects', () => {
    const res = ok({
      comments: [
        { id: 'a', supportLovelace: BigInt('1000000000') },
        { id: 'b', supportLovelace: BigInt('40000000000000001'), nested: { x: 100n } },
      ],
    });
    const body = JSON.parse((res as { body: string }).body) as {
      data: {
        comments: Array<{ id: string; supportLovelace: string; nested?: { x: string } }>;
      };
    };
    expect(body.data.comments[0]!.supportLovelace).toBe('1000000000');
    expect(body.data.comments[1]!.supportLovelace).toBe('40000000000000001');
    expect(body.data.comments[1]!.nested!.x).toBe('100');
  });

  it('leaves non-bigint values untouched', () => {
    const res = ok({ ok: true, n: 42, s: 'hello', list: [1, 'two', null] });
    const body = JSON.parse((res as { body: string }).body) as {
      data: { ok: boolean; n: number; s: string; list: unknown[] };
    };
    expect(body.data.ok).toBe(true);
    expect(body.data.n).toBe(42);
    expect(body.data.s).toBe('hello');
    expect(body.data.list).toEqual([1, 'two', null]);
  });
});
