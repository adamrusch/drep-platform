// SessionStore — KV-equivalent abstraction over the session record + per-user
// index DRep Talk's `auth/session.ts` writes. Production swaps in a DDB-backed
// impl; tests use an in-memory impl that mirrors KV TTL semantics.
//
// The ported `auth/session.ts` keeps its KV-style call shape (put/get/delete
// raw string values with a TTL hint, looked up by key), so the store interface
// is intentionally narrow — it doesn't know about session-vs-index records,
// just keys and string blobs.

export interface SessionStore {
  /** Store a string `value` under `key`, replacing any existing value.
   *  `ttlSec` is the lifetime hint (KV TTL or DynamoDB TTL attribute). */
  put(key: string, value: string, ttlSec: number): Promise<void>;
  /** Look up a string by key. Returns null if absent OR expired
   *  (DDB TTL-lag defense — mirrors the nonce store). */
  get(key: string): Promise<string | null>;
  /** Delete a key. Idempotent — no-op if the key is already absent. */
  delete(key: string): Promise<void>;
}

export type NowFn = () => number;

export const defaultNow: NowFn = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// In-memory implementation (for unit tests).
// ---------------------------------------------------------------------------

interface MemoryRecord {
  value: string;
  expiresAt: number; // epoch seconds
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly now: NowFn;

  constructor(now: NowFn = defaultNow) {
    this.now = now;
  }

  async put(key: string, value: string, ttlSec: number): Promise<void> {
    // KV semantics: put overwrites unconditionally.
    this.records.set(key, { value, expiresAt: this.now() + ttlSec });
  }

  async get(key: string): Promise<string | null> {
    const record = this.records.get(key);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      // Best-effort eviction. Mirrors KV/TTL semantics.
      this.records.delete(key);
      return null;
    }
    return record.value;
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  /** Test helper — clear all records. */
  clear(): void {
    this.records.clear();
  }
}
