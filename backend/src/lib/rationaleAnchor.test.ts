import { describe, it, expect } from 'vitest';
import { canonicalize, blake2b256Hex, buildRationaleAnchor } from './rationaleAnchor';
import type { CommitteeRationaleDraftItem } from './types';

const draft = (over: Partial<CommitteeRationaleDraftItem> = {}): CommitteeRationaleDraftItem => ({
  voteScope: 'd#a',
  itemKey: 'RATIONALE#DRAFT',
  drepId: 'd',
  actionId: 'a',
  rationaleStatement: 'We support this for reasons X and Y.',
  updatedAt: '2026-05-30T00:00:00.000Z',
  ...over,
});

describe('canonicalize', () => {
  it('sorts keys deterministically regardless of insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('drops undefined and recurses into nested objects/arrays', () => {
    expect(canonicalize({ a: undefined, b: { d: 1, c: 2 }, e: [{ z: 1, y: 2 }] })).toBe(
      '{"b":{"c":2,"d":1},"e":[{"y":2,"z":1}]}',
    );
  });
});

describe('blake2b256Hex', () => {
  it('is 64 hex chars and stable', () => {
    const h = blake2b256Hex('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(blake2b256Hex('hello')).toBe(h);
    expect(blake2b256Hex('hello!')).not.toBe(h);
  });
});

describe('buildRationaleAnchor', () => {
  const meta = { drepId: 'd', actionId: 'a', position: 'Yes' as const };

  it('produces a stable hash for the same content', () => {
    const a = buildRationaleAnchor(draft(), meta);
    const b = buildRationaleAnchor(draft(), meta);
    expect(a.anchorHash).toBe(b.anchorHash);
    expect(a.anchorHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash is over the canonical bytes', () => {
    const { canonicalJson, anchorHash } = buildRationaleAnchor(draft(), meta);
    expect(blake2b256Hex(canonicalJson)).toBe(anchorHash);
  });

  it('different rationale content yields a different hash', () => {
    const a = buildRationaleAnchor(draft(), meta);
    const b = buildRationaleAnchor(draft({ rationaleStatement: 'Different.' }), meta);
    expect(a.anchorHash).not.toBe(b.anchorHash);
  });
});
