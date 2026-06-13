// DynamoDB-backed NonceStore for production.
//
// Uses the existing `tableNames.authNonces` table (PK: `nonce`, attributes
// `expiresAt` (epoch seconds) for DDB TTL). To avoid colliding with the
// legacy `lib/auth.ts` records (`kind = 'challenge' | 'mutation' | 'drep_link'`)
// this impl writes `kind = 'identity'`. The reads only check `expiresAt` and
// the payload string match — `kind` is informational.
//
// CRITICAL — KV vs DDB TTL behaviour: Cloudflare KV auto-expires entries on
// the TTL boundary. DynamoDB's TTL deletion lags by up to 48 hours. Every read
// MUST do an explicit `expiresAt <= now` check and treat an expired record as
// absent. The in-memory store mirrors this for parity with production.
import {
  putItem,
  getItem,
  deleteItem,
  tableNames,
} from '../../dynamodb';
import { type NonceStore, type NowFn, defaultNow } from './nonceStore';

interface NonceRecord extends Record<string, unknown> {
  nonce: string;
  kind: 'identity';
  payload: string;
  expiresAt: number; // epoch seconds for DynamoDB TTL
}

export class DynamoDbNonceStore implements NonceStore {
  private readonly now: NowFn;

  constructor(now: NowFn = defaultNow) {
    this.now = now;
  }

  async put(nonce: string, payload: string, ttlSec: number): Promise<void> {
    const item: NonceRecord = {
      nonce,
      kind: 'identity',
      payload,
      expiresAt: this.now() + ttlSec,
    };
    // attribute_not_exists(#nonce) enforces append-only: a concurrent put for
    // the same nonce fails atomically. Random 256-bit nonces never collide in
    // practice; this is the safety net.
    await putItem(tableNames.authNonces, item, 'attribute_not_exists(#nonce)', {
      '#nonce': 'nonce',
    });
  }

  async get(nonce: string): Promise<string | null> {
    const stored = await getItem<NonceRecord>(tableNames.authNonces, { nonce });
    if (stored?.kind !== 'identity') return null;
    if (this.now() > stored.expiresAt) {
      // KV TTL would have already deleted this; DDB TTL deletion lags. Treat
      // as absent and best-effort delete to keep the table tidy.
      try {
        await deleteItem(tableNames.authNonces, { nonce });
      } catch {
        // Best-effort cleanup; ignore failures.
      }
      return null;
    }
    return stored.payload;
  }

  async delete(nonce: string): Promise<boolean> {
    try {
      await deleteItem(
        tableNames.authNonces,
        { nonce },
        'attribute_exists(#nonce)',
        { '#nonce': 'nonce' },
      );
      // Conditional delete succeeded → THIS caller removed the row.
      return true;
    } catch (err) {
      // M2 fix (2026-06-10 security review) — return `false` instead of
      // swallowing as `void` when the row was already gone. A concurrent
      // consumer that lost the race needs to learn it lost; without this
      // signal, two consumers could both report `consumeNonce → true`
      // and mint two sessions from one signature. The DDB conditional
      // delete is atomic: exactly one caller flips the row from present
      // to absent and sees no exception; every other caller sees CCFE
      // and returns `false`. Anything else (real DDB error) rethrows so
      // the caller can fail closed.
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw err;
    }
  }
}
