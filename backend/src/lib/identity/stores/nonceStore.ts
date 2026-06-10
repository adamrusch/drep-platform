// NonceStore — abstraction over the KV-equivalent storage the ported
// `auth/nonce.ts` uses. DRep Talk targets Cloudflare KV; this module ports the
// nonce logic but leaves storage behind an interface so we can plug in:
//   - DynamoDB in production (uses the existing `tableNames.authNonces` table
//     and the explicit post-read expiry check legacy `lib/auth.ts` already does;
//     KV TTL auto-expires but DynamoDB TTL deletion lags by minutes, so every
//     read MUST re-check expiry and treat an expired record as absent), and
//   - an in-memory implementation for tests (also expiry-aware so tests can
//     advance "now" without relying on real timeouts).
//
// The store stores raw `payload` strings keyed by the `nonce` segment of the
// payload. The ported nonce verifier parses the payload to extract the nonce
// segment, looks it up, and requires the stored value to match the payload
// byte-for-byte. That string-equality check is what binds stage, domain, and
// issuedAt to the lookup — a tampered-domain payload (different bytes) cannot
// hit the same stored value as the legit one even if the nonce segment is
// reused.

export interface NonceStore {
  /** Insert a payload keyed by `nonce` with an `expiresAt` epoch-seconds value.
   *  Implementations should be append-only (no overwrite) if collisions are
   *  possible; the production DDB impl uses `attribute_not_exists(nonce)`.
   *  The TTL hint is `ttlSec` seconds from now. */
  put(nonce: string, payload: string, ttlSec: number): Promise<void>;
  /** Look up a payload by nonce. Returns null if absent OR if the record's
   *  recorded expiry is in the past (KV→DDB TTL-lag defense). */
  get(nonce: string): Promise<string | null>;
  /** Atomic delete. Production impl uses a conditional delete so two concurrent
   *  consume calls cannot both succeed; the in-memory impl mimics this. */
  delete(nonce: string): Promise<void>;
}

/** A clock injected for tests. Epoch seconds. */
export type NowFn = () => number;

export const defaultNow: NowFn = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// In-memory implementation (for unit tests).
// ---------------------------------------------------------------------------

interface MemoryRecord {
  payload: string;
  expiresAt: number; // epoch seconds
}

export class InMemoryNonceStore implements NonceStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly now: NowFn;

  constructor(now: NowFn = defaultNow) {
    this.now = now;
  }

  async put(nonce: string, payload: string, ttlSec: number): Promise<void> {
    // Mirror DDB's `attribute_not_exists(nonce)` semantics: a put that races
    // with an existing live record is rejected. In practice nonces are 256-bit
    // random so collisions never happen; this just keeps the contract honest.
    const existing = this.records.get(nonce);
    if (existing && existing.expiresAt > this.now()) {
      throw new Error(`nonce ${nonce} already exists`);
    }
    this.records.set(nonce, { payload, expiresAt: this.now() + ttlSec });
  }

  async get(nonce: string): Promise<string | null> {
    const record = this.records.get(nonce);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      // Best-effort eviction. Behaviour-equivalent to the legacy
      // `auth.ts`'s "delete on expired peek" defense.
      this.records.delete(nonce);
      return null;
    }
    return record.payload;
  }

  async delete(nonce: string): Promise<void> {
    this.records.delete(nonce);
  }

  /** Test helper — clear all records. */
  clear(): void {
    this.records.clear();
  }
}
