/**
 * Append-only audit-event writer for the `audit_log` DynamoDB table.
 *
 * # Why this module exists (Oracle's #1 credibility item, 2026-05-28)
 *
 * The `audit_log` table was provisioned by `DatabaseStack` from day one
 * (PK=`pk` = `entityType#entityId`, SK=`sk` = `timestamp#eventType`,
 * PITR on, 365d `ttl`) but NO production code wrote to it. For a
 * governance platform, "who did what, when" is table stakes — without
 * it, an incident-response question like "did this delete really come
 * from the post author?" or "when did this committee get registered?"
 * has no answer in our records. This module is the single chokepoint
 * for mutation-audit writes; every mutation handler calls
 * `writeAuditEvent` AFTER the underlying mutation succeeds.
 *
 * # Best-effort contract — IMMOVABLE INVARIANT
 *
 * `writeAuditEvent` MUST NEVER throw. A failure to write the audit row
 * MUST NEVER fail or 5xx the underlying mutation. An audit system that
 * can take down the write path is worse than no audit system: it
 * inverts the safety contract — instead of "we know what happened" we
 * get "we lost the comment because our recordkeeping was broken."
 *
 * Implementation: the entire put call is wrapped in `try/catch`. Any
 * error is logged via `console.warn` (so it surfaces in CloudWatch but
 * doesn't page) and swallowed. The function's return type is `void` —
 * callers cannot `await` for a write confirmation because there isn't
 * one to give. The audit table is also append-only with PITR; even if
 * a row is lost, the underlying state change is recoverable from the
 * source table's own PITR.
 *
 * # Key shape (matches `docs/SCHEMA.md`)
 *
 *   - `pk` = `${entityType}#${entityId}` — partition key. All events
 *     for one entity colocate in one partition; the audit reader does
 *     `Query(pk)` to reconstruct an entity's history.
 *   - `sk` = `${timestamp}#${eventType}` — sort key. ISO-8601 timestamps
 *     sort lexicographically; `eventType` disambiguates same-millisecond
 *     events on the same entity (rare but possible — e.g. atomic
 *     `transactWrite` succeeding then immediately failing a follow-up).
 *
 * # TTL
 *
 * Every row carries a `ttl` set to `nowSec + 365d`. DynamoDB's TTL
 * sweeper deletes rows lazily — the actual delete may lag the TTL
 * timestamp by hours, but our analysis horizon is "the last year of
 * activity" so the lag is irrelevant. Schema docs (`docs/SCHEMA.md`)
 * pin the `ttl` attribute name.
 *
 * # Metadata discipline
 *
 *   - Keep `metadata` MINIMAL and NON-SENSITIVE. IDs + counts + outcome.
 *     NOT the comment body, NOT PII beyond the wallet address (which
 *     is already public-on-chain).
 *   - `actorWallet` is the verified bech32 stake address from the auth
 *     context. For unauthenticated mutations (none today), the caller
 *     should pass `'_anonymous'` rather than omit.
 *
 * # Security-relevant rejections
 *
 * Some call sites audit FAILED mutations — e.g. a 403 forbidden on a
 * delete gate, or a 503 delegation-unknown rejection on the fail-closed
 * clubhouse gate. These are the rows an incident responder needs to
 * spot abuse patterns. Use eventTypes like `clubhouse.post.denied` or
 * `auth.delegation_unverified` to distinguish from successful mutations.
 */

import { putItem, tableNames } from './dynamodb';
import type { AuditLogItem } from './types';

/** Audit-log row TTL in seconds. Set to 365 days — long enough for an
 *  annual incident-review horizon, short enough that the table stays
 *  bounded without manual housekeeping. */
const AUDIT_LOG_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Input shape for an audit-event write. Mirrors `AuditLogItem` minus the
 * derived fields (`pk`, `sk`, `ttl`, `timestamp`) the helper computes.
 */
export interface AuditEventInput {
  /** Coarse category of the entity being audited. Examples used today:
   *  `'comment' | 'comment_vote' | 'clubhouse_post' | 'clubhouse_comment'
   *  | 'clubhouse_poll_vote' | 'user_profile' | 'drep_committee' | 'auth'`.
   *  Together with `entityId` it forms the partition key, so consistency
   *  matters — keep the set narrow and documented inline at call sites. */
  entityType: string;
  /** Natural key of the entity. Examples: `commentId`, `postId`,
   *  `actionId`, `drepId`, `walletAddress`. For `entityType='auth'`,
   *  this is the wallet that authenticated. For composite entities
   *  (e.g. a clubhouse post that's scoped to a DRep) prefer the most
   *  specific id (`postId`) — the eventType carries the relationship. */
  entityId: string;
  /** Dotted-namespace event verb. Examples:
   *  - `comment.created` / `comment.voted` / `comment.deleted`
   *  - `clubhouse.post.created` / `clubhouse.post.deleted`
   *  - `clubhouse.comment.created`
   *  - `clubhouse.poll.voted`
   *  - `auth.login`
   *  - `profile.updated`
   *  - `drep.committee.registered`
   *  - `clubhouse.post.denied` (403 on a delete gate)
   *  - `auth.delegation_unverified` (503 on the fail-closed gate)
   *  Encode "who did what to what" — read this field first when
   *  reconstructing an incident timeline. */
  eventType: string;
  /** Bech32 stake address of the caller. For unauthenticated mutations
   *  (none today), pass `'_anonymous'`. Public-on-chain data — safe to
   *  log verbatim. */
  actorWallet: string;
  /** OPTIONAL — minimal, non-sensitive context. IDs + counts + outcome
   *  only. Do NOT include comment bodies, user-provided text, or
   *  PII beyond `actorWallet`. Typical fields: `actionId`, `drepId`,
   *  `targetWallet`, `voteDirection`, `priorRoleSet`, `deletedCount`.
   *  Survives `removeUndefinedValues: true` marshalling on the doc
   *  client — keys with `undefined` values are dropped on write. */
  metadata?: Record<string, unknown>;
}

/**
 * Compose the `pk`/`sk`/`ttl` triple from an `AuditEventInput`. Pure
 * function — exported so the test suite can assert the wire shape
 * without going through the DDB mock.
 *
 * `timestamp` is the source-of-truth for `sk` ordering and for the
 * `timestamp` field on the persisted row. Tests inject a fixed value
 * for determinism; live callers omit and the helper generates a
 * fresh ISO-8601 `Date.now()` per write.
 */
export function buildAuditRow(
  input: AuditEventInput,
  now: Date = new Date(),
): AuditLogItem {
  const timestamp = now.toISOString();
  const pk = `${input.entityType}#${input.entityId}`;
  const sk = `${timestamp}#${input.eventType}`;
  const ttl = Math.floor(now.getTime() / 1000) + AUDIT_LOG_TTL_SECONDS;
  return {
    pk,
    sk,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    actorWallet: input.actorWallet,
    timestamp,
    ttl,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

/**
 * Write a single audit-event row to `audit_log`. Best-effort — failures
 * are logged + swallowed. Returns `void` (no `Promise<void>` for the
 * write outcome) — callers MUST NOT branch on this completing.
 *
 * Typical call site (in a handler, AFTER the mutation has succeeded):
 *
 *   await writeAuditEvent({
 *     entityType: 'comment',
 *     entityId: commentId,
 *     eventType: 'comment.created',
 *     actorWallet: authCtx.walletAddress,
 *     metadata: { actionId, parentCommentId, isPublic, isDRep },
 *   });
 *
 * Note that we DO `await` the call — that's so the Lambda's invocation
 * lifecycle doesn't tear down before the put completes. But because the
 * await is on a promise that never rejects (we catch internally), the
 * caller cannot observe a failure here.
 */
export async function writeAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    const row = buildAuditRow(input);
    await putItem(
      tableNames.auditLog,
      row as unknown as Record<string, unknown>,
    );
  } catch (err) {
    // Best-effort: never let an audit-write failure propagate. We log
    // at warn level so the failure is visible in CloudWatch (and shows
    // up in any error-rate alarms keyed on the audit Lambda's own
    // metrics, if those are ever wired) without paging.
    console.warn(
      `audit: failed to write event entityType=${input.entityType} entityId=${input.entityId} eventType=${input.eventType}:`,
      err,
    );
  }
}

/** Exported for tests that want to validate the TTL math without
 *  reaching into a row. Returns the seconds-since-epoch for the TTL
 *  attribute on a row written `at` the given Date. */
export function auditTtlForDate(at: Date): number {
  return Math.floor(at.getTime() / 1000) + AUDIT_LOG_TTL_SECONDS;
}
