// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Converted from `nonce.workers.test.ts` to run on vitest's Node pool using
// the in-memory NonceStore fake instead of a Cloudflare KVNamespace.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  issueNonce,
  consumeNonce,
  peekNonce,
  consumeNonceWithCheck,
  LINK_PAYLOAD_PREFIX,
} from './nonce';
import { InMemoryNonceStore } from '../stores/nonceStore';

let store: InMemoryNonceStore;

beforeEach(() => {
  store = new InMemoryNonceStore();
});

describe('issueNonce', () => {
  it('returns a nonce and a stage-bound payload', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
    expect(payload).toMatch(/^dreptalk:test:example\.com:[^:]+:\d+$/);
    expect(payload).toContain(`:${nonce}:`);
  });

  it('stores the nonce in the store retrievable by key', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const stored = await store.get(nonce);
    expect(stored).toBe(payload);
  });

  it('uses the provided now value for issuedAt', async () => {
    const fixedNow = 1_700_000_000;
    const { payload } = await issueNonce(store, {
      domain: 'test.io',
      stage: 'prod',
      now: fixedNow,
    });
    expect(payload.endsWith(`:${fixedNow}`)).toBe(true);
  });

  it('binds stage into the payload', async () => {
    const a = await issueNonce(store, { domain: 'd.com', stage: 'test' });
    const b = await issueNonce(store, { domain: 'd.com', stage: 'prod' });
    expect(a.payload.split(':')[1]).toBe('test');
    expect(b.payload.split(':')[1]).toBe('prod');
  });
});

describe('consumeNonce', () => {
  it('returns true and deletes the key on first consume', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const result = await consumeNonce(store, payload);
    expect(result).toBe(true);
    const remaining = await store.get(nonce);
    expect(remaining).toBeNull();
  });

  it('returns false on second consume (replay rejection)', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const first = await consumeNonce(store, payload);
    expect(first).toBe(true);
    const second = await consumeNonce(store, payload);
    expect(second).toBe(false);
  });

  it('returns false for a tampered payload (different domain)', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'legit.com',
      stage: 'test',
    });
    const tampered = payload.replace('dreptalk:test:legit.com:', 'dreptalk:test:evil.com:');
    const result = await consumeNonce(store, tampered);
    expect(result).toBe(false);
    // Original key remains since the tampered lookup did not match.
    const stored = await store.get(nonce);
    expect(stored).not.toBeNull();
  });

  it('returns false for a tampered payload (different stage)', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const tampered = payload.replace('dreptalk:test:', 'dreptalk:prod:');
    const result = await consumeNonce(store, tampered);
    expect(result).toBe(false);
    const stored = await store.get(nonce);
    expect(stored).not.toBeNull();
  });

  it('returns false when expectedStage does not match the payload stage', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const result = await consumeNonce(store, payload, { expectedStage: 'prod' });
    expect(result).toBe(false);
  });

  it('returns true when expectedStage matches the payload stage', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const result = await consumeNonce(store, payload, { expectedStage: 'test' });
    expect(result).toBe(true);
  });

  it('returns false for a tampered payload (different nonce in key lookup)', async () => {
    const { payload } = await issueNonce(store, { domain: 'a.com', stage: 'test' });
    const parts = payload.split(':');
    const nonceIdx = parts.length - 2;
    const original = parts[nonceIdx];
    expect(original).toBeDefined();
    parts[nonceIdx] = original!.slice(0, -1) + (original!.endsWith('A') ? 'B' : 'A');
    const tampered = parts.join(':');
    const result = await consumeNonce(store, tampered);
    expect(result).toBe(false);
  });

  it('returns false when issuedAt is older than maxAgeSec', async () => {
    const issuedAt = 1_700_000_000;
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
      now: issuedAt,
    });
    const result = await consumeNonce(store, payload, { now: issuedAt + 301, maxAgeSec: 300 });
    expect(result).toBe(false);
  });

  it('returns false when issuedAt is in the future relative to now', async () => {
    const now = 1_700_000_000;
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
      now: now + 60,
    });
    const result = await consumeNonce(store, payload, { now });
    expect(result).toBe(false);
  });

  it('returns false for a malformed payload (not enough segments)', async () => {
    expect(await consumeNonce(store, 'not-a-valid-payload')).toBe(false);
    expect(await consumeNonce(store, '')).toBe(false);
    expect(await consumeNonce(store, 'dreptalk:only-two-parts')).toBe(false);
    expect(await consumeNonce(store, 'dreptalk:test:only-three:parts')).toBe(false);
  });

  it('returns false for a payload with wrong prefix', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const wrongPrefix = `othertalk${payload.slice('dreptalk'.length)}`;
    expect(await consumeNonce(store, wrongPrefix)).toBe(false);
  });

  it('returns false when issuedAt segment is non-numeric', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const parts = payload.split(':');
    parts[parts.length - 1] = 'not-a-number';
    const tampered = parts.join(':');
    const result = await consumeNonce(store, tampered);
    expect(result).toBe(false);
    const stored = await store.get(nonce);
    expect(stored).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M1 (2026-06-10 security review) — link-flow boundContext binding
// ---------------------------------------------------------------------------

describe('issueNonce + parsePayload — link-flow boundContext (M1)', () => {
  it('emits a `dreptalk-link:<personId>:<stage>:<domain>:<nonce>:<ts>` payload', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'drep.tools',
      stage: 'test',
      prefix: LINK_PAYLOAD_PREFIX,
      boundContext: '01HSOMEPERSONULID',
    });
    expect(payload).toMatch(
      /^dreptalk-link:01HSOMEPERSONULID:test:drep\.tools:[^:]+:\d+$/,
    );
  });

  it('peekNonce parses the bound personId out of a link payload', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'drep.tools',
      stage: 'test',
      prefix: LINK_PAYLOAD_PREFIX,
      boundContext: '01HBOUNDPERSON',
    });
    const peek = await peekNonce(store, payload, {
      prefix: LINK_PAYLOAD_PREFIX,
    });
    expect(peek.ok).toBe(true);
    if (peek.ok) {
      expect(peek.parsed.boundContext).toBe('01HBOUNDPERSON');
    }
  });

  it('rejects a link payload when the prefix is wrong (standard vs link)', async () => {
    // A standard `dreptalk:...` payload must NOT validate under the
    // LINK prefix and vice-versa.
    const { payload: standard } = await issueNonce(store, {
      domain: 'drep.tools',
      stage: 'test',
    });
    const standardUnderLink = await peekNonce(store, standard, {
      prefix: LINK_PAYLOAD_PREFIX,
    });
    expect(standardUnderLink.ok).toBe(false);
  });

  it('rejects a boundContext containing a colon (shape invariant)', async () => {
    await expect(
      issueNonce(store, {
        domain: 'drep.tools',
        stage: 'test',
        prefix: LINK_PAYLOAD_PREFIX,
        boundContext: 'has:colon',
      }),
    ).rejects.toThrow(/boundContext must not contain a colon/);
  });
});

// ---------------------------------------------------------------------------
// M2 (2026-06-10 security review) — atomic single-use under concurrency
// ---------------------------------------------------------------------------

describe('consumeNonce — atomic single-use (M2)', () => {
  it('two concurrent consumers of the same nonce: exactly one true', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    // Fire both consumers at the same tick. The atomic-delete contract
    // says exactly one wins — the other sees `false` from `delete` and
    // returns `false`. Pre-fix (DDB adapter swallowed CCFE as void) both
    // would return `true` and the caller could mint two sessions from
    // one signature.
    const [a, b] = await Promise.all([
      consumeNonce(store, payload),
      consumeNonce(store, payload),
    ]);
    const wins = [a, b].filter(Boolean).length;
    expect(wins).toBe(1);
  });

  it('store.delete returns true the first time, false on second call', async () => {
    // Directly exercise the boolean contract on `NonceStore.delete`.
    const { nonce } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    expect(await store.delete(nonce)).toBe(true);
    expect(await store.delete(nonce)).toBe(false);
  });

  it('consumeNonceWithCheck: racer that lost the delete gets ok:false', async () => {
    const { payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    // Run two consumeNonceWithCheck calls in parallel, each passing
    // the `ok:true` arm. Exactly one wins.
    const [a, b] = await Promise.all([
      consumeNonceWithCheck(store, payload, async () => ({ ok: true, value: 'A' })),
      consumeNonceWithCheck(store, payload, async () => ({ ok: true, value: 'B' })),
    ]);
    const wins = [a, b].filter((r) => r.ok).length;
    expect(wins).toBe(1);
    // The loser carries the documented reason.
    const loser = [a, b].find((r) => !r.ok);
    expect(loser?.ok).toBe(false);
    if (loser && !loser.ok) {
      expect(loser.reason).toBe('nonce already consumed');
    }
  });
});

describe('peekNonce + consumeNonceWithCheck (burn defense)', () => {
  it('peek validates without deleting', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const peek = await peekNonce(store, payload);
    expect(peek.ok).toBe(true);
    // Still present after peek.
    expect(await store.get(nonce)).not.toBeNull();
  });

  it('consumeNonceWithCheck keeps the nonce alive when the check fails', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const result = await consumeNonceWithCheck(
      store,
      payload,
      async () => ({ ok: false, reason: 'fake signature failure' }),
    );
    expect(result.ok).toBe(false);
    // Nonce should still be in the store — attacker burn defense.
    expect(await store.get(nonce)).not.toBeNull();
  });

  it('consumeNonceWithCheck deletes the nonce when the check succeeds', async () => {
    const { nonce, payload } = await issueNonce(store, {
      domain: 'example.com',
      stage: 'test',
    });
    const result = await consumeNonceWithCheck(
      store,
      payload,
      async () => ({ ok: true, value: 'verified' }),
    );
    expect(result).toEqual({ ok: true, value: 'verified' });
    expect(await store.get(nonce)).toBeNull();
  });
});
