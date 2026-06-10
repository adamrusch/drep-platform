// DynamoDB-backed SessionStore for production.
//
// NOTE — INFRA WIRING DEFERRED: this implementation reads/writes a
// session-records table keyed by `key` (the SHA-256-hash KV-style key the
// ported `auth/session.ts` builds), with the JSON blob in a `value` attribute
// and a `expiresAt` epoch-seconds column for DynamoDB TTL. The infra stack
// does not yet create this table (the live handler path doesn't use the
// ported session module yet — that wiring is a later sprint per the brief).
//
// Until the table is provisioned, callers should construct this store with an
// explicit `tableName` argument (e.g. `${prefix}identity_sessions`) and ensure
// the CDK stack creates that table with PK `key` and TTL attribute `expiresAt`.
// The shape matches what the legacy `tableNames.authNonces` table looks like,
// so adding it is a copy-paste of an existing CDK table definition.

import { putItem, getItem, deleteItem } from '../../dynamodb';
import { type SessionStore, type NowFn, defaultNow } from './sessionStore';

interface SessionItem extends Record<string, unknown> {
  key: string;
  value: string;
  expiresAt: number; // epoch seconds for DynamoDB TTL
}

export class DynamoDbSessionStore implements SessionStore {
  private readonly now: NowFn;
  private readonly tableName: string;

  constructor(tableName: string, now: NowFn = defaultNow) {
    this.tableName = tableName;
    this.now = now;
  }

  async put(key: string, value: string, ttlSec: number): Promise<void> {
    const item: SessionItem = {
      key,
      value,
      expiresAt: this.now() + ttlSec,
    };
    // KV semantics: put overwrites unconditionally (no ConditionExpression).
    await putItem(this.tableName, item);
  }

  async get(key: string): Promise<string | null> {
    const stored = await getItem<SessionItem>(this.tableName, { key });
    if (!stored) return null;
    if (this.now() > stored.expiresAt) {
      // DDB TTL deletion lags; explicit check + best-effort cleanup.
      try {
        await deleteItem(this.tableName, { key });
      } catch {
        // Ignore — best-effort.
      }
      return null;
    }
    return stored.value;
  }

  async delete(key: string): Promise<void> {
    try {
      await deleteItem(this.tableName, { key });
    } catch {
      // Idempotent — swallow any error from a missing key.
    }
  }
}
