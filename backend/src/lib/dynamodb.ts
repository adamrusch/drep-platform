import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  GetCommandInput,
  PutCommand,
  PutCommandInput,
  QueryCommand,
  QueryCommandInput,
  DeleteCommand,
  DeleteCommandInput,
  UpdateCommand,
  UpdateCommandInput,
  TransactWriteCommand,
  TransactWriteCommandInput,
  ScanCommand,
  ScanCommandInput,
  BatchGetCommand,
  BatchGetCommandInput,
} from '@aws-sdk/lib-dynamodb';

// ---- Client setup ----

const rawClient = new DynamoDBClient({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
});

/**
 * DDB number unmarshaller — returns `bigint` for any DynamoDB `N` value
 * whose magnitude exceeds `Number.MAX_SAFE_INTEGER`, otherwise `number`.
 *
 * # Why this is non-default
 *
 * The lib-dynamodb default (`wrapNumbers: false`) parses every `N` as a
 * native JS `number`, silently losing precision for values past 2^53
 * (≈ 9.0×10^15). On Cardano mainnet, lovelace accumulators like
 * `comments.supportLovelace` can grow past that ceiling (total ADA
 * supply ≈ 4.5×10^16 lovelace), so a popular comment's running support
 * total would drift after enough votes. The 2026-05-28 P0-2 fix flipped
 * `supportLovelace` from `S` to `N` so that DDB's atomic `ADD` could
 * be used; this complementary unmarshaller keeps the read side honest.
 *
 * # Why `bigint` only past the safe-int threshold
 *
 * Returning `bigint` for EVERY `N` would change the runtime type of
 * many existing numeric fields (`upvoteCount`, `enrichmentVersion`,
 * `epochNo`, …) which are typed as `number` everywhere and would
 * silently break arithmetic (`bigint + number` throws TypeError). The
 * threshold means: small counters keep their existing `number` type;
 * only the handful of fields that can grow past 2^53 (today only
 * `supportLovelace`) start arriving as `bigint`. Consumers of those
 * fields already pass through `safeBigInt` or `BigInt(…)` which accept
 * both `number` and `bigint`.
 */
function smartUnwrapNumber(value: string): number | bigint {
  // Floating-point-shaped values (decimals, scientific notation) can't be
  // BigInt; let them through as JS numbers. DDB rarely stores non-integer
  // numerics in this codebase but the guard is cheap.
  if (value.includes('.') || value.includes('e') || value.includes('E')) {
    return Number(value);
  }
  try {
    const asBig = BigInt(value);
    if (
      asBig <= BigInt(Number.MAX_SAFE_INTEGER) &&
      asBig >= BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return Number(value);
    }
    return asBig;
  } catch {
    return Number(value);
  }
}

export const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    wrapNumbers: smartUnwrapNumber,
  },
});

// ---- Table name helpers ----

const TABLE_PREFIX = process.env['DYNAMODB_TABLE_PREFIX'] ?? 'drep-platform-dev-';

export const tableNames = {
  users: `${TABLE_PREFIX}users`,
  drepCommittees: `${TABLE_PREFIX}drep_committees`,
  drepDirectory: `${TABLE_PREFIX}drep_directory`,
  governanceActions: `${TABLE_PREFIX}governance_actions`,
  /** Per-vote event log; PK=actionId, SK=`${voterRole}#${voterId}#${voteTxHash}`.
   *  Append-only via conditional Put. Populated by `governance-intake.ts` from
   *  the Koios `/vote_list` feed. See infra/lib/database-stack.ts and
   *  docs/SCHEMA.md for the full item shape. */
  governanceVotes: `${TABLE_PREFIX}governance_votes`,
  comments: `${TABLE_PREFIX}comments`,
  /** Per-vote rows for comment up/downvotes. PK=`commentId`, SK=`stakeAddress`.
   *  One row per (comment, voter) tuple — recasting overwrites the row. Sum-
   *  on-read aggregation is replaced by a denormalized `supportLovelace`
   *  counter on the comments row, kept consistent via `transactWrite` from
   *  the vote handler. See `handlers/comments/vote.ts`.
   *
   *  GSI `stakeAddress-commentId-index` (PK=`stakeAddress`, SK=`commentId`,
   *  projecting `{vote, lovelace, actionId}`) lets the 3-hourly stake
   *  re-validation sweep enumerate every vote belonging to one wallet
   *  in a single-partition Query — see `backend/src/sync/revalidate-
   *  comment-stake.ts` and `infra/lib/database-stack.ts`. */
  commentVotes: `${TABLE_PREFIX}comment_votes`,
  /** Registry of distinct comment-voting wallets with their last-known
   *  stake snapshot. Populated upsert-on-vote (atomic `ADD voteCount`
   *  + `SET lastKnownStake/lastCheckedAt`) from the vote-write paths,
   *  and consumed by the 3-hourly `revalidate-comment-stake` sync
   *  Lambda (Batch REVAL, 2026-05-29) to enumerate every voter for
   *  the Sybil-defense re-weight pass. PK=`stakeAddress`, no SK. See
   *  `infra/lib/database-stack.ts` for full rationale. */
  commentVoters: `${TABLE_PREFIX}comment_voters`,
  clubhousePosts: `${TABLE_PREFIX}clubhouse_posts`,
  /** Per-comment rows for the Clubhouse threading surface. Replaces the
   *  legacy inline `clubhouse_posts.comments[]` array (P0-3 migration,
   *  2026-05-28). PK=`postKey` (= `${drepId}#${postId}`), SK=`commentId`
   *  (ULID). Counters (`commentCount`, `lastReplyAt`) are denormalized
   *  onto the parent `clubhouse_posts` row via atomic `ADD` / `SET` from
   *  the `createComment` handler — no read-modify-write of the comment
   *  set is ever required to render the badge or rank the rail. See
   *  `infra/lib/database-stack.ts` for the table definition and rationale. */
  clubhouseComments: `${TABLE_PREFIX}clubhouse_comments`,
  /** SPO ticker / name / homepage cache populated daily by
   *  `sync/pool-metadata.ts` from Koios `/pool_list` + `/pool_metadata`.
   *  PK=`poolId` (bech32 `pool1...`). Read by `recognition.ts`'s
   *  `getPoolName` and joined onto SPO vote rows by `lib/votes.ts`. */
  poolMetadata: `${TABLE_PREFIX}pool_metadata`,
  /** Constitutional Committee member roster populated by
   *  `sync/cc-members.ts` from Koios `/committee_info`, refreshed once
   *  per epoch. PK=`ccHotCred` (bech32 `cc_hot...`); reserved row
   *  `ccHotCred='META'` carries the epoch-skip cursor. */
  ccMembers: `${TABLE_PREFIX}cc_members`,
  auditLog: `${TABLE_PREFIX}audit_log`,
  authNonces: `${TABLE_PREFIX}auth_nonces`,
  /** Decision #1 (2026-06-10) — per-session revocation store for the
   *  on-chain login JWTs.
   *
   *  PK = `sessionKey` = SHA-256(jti) hex. One row per session: stores
   *  the active state (`revoked:false`) at login time and is flipped
   *  to `revoked:true` on logout / "log out everywhere" / cron-driven
   *  role revalidation. TTL on `expiresAt` removes the row when the
   *  underlying JWT can no longer be presented (~30 days).
   *
   *  GSI `identityId-issuedAt-index` (PK=`identityId`, SK=`issuedAt`,
   *  projection ALL) — used by `revokeAllSessionsForUser` to fan out
   *  per-identity revokes without a Scan, and by the daily role-
   *  revalidation cron to enumerate active identities.
   *
   *  Replaces the prior Sprint-1 reuse of `authNonces` with
   *  `kind='session' | 'session_index'` discriminators. The legacy
   *  CIP-30 login path (`backend/src/lib/auth.ts`) does NOT use this
   *  table — its session revocation is the `tokenVersion` row counter
   *  on the `users` table. See `backend/src/lib/sessionRevocation.ts`
   *  for the full design + the public surface every caller (authorizer,
   *  logout, on-chain verify, cron) reads. */
  identitySessions: `${TABLE_PREFIX}identity_sessions`,
  /** Decision #3 (2026-06-10) — canonical "person" table for the
   *  on-chain identity subsystem.
   *
   *  PK = `personId` (ULID). One row per recognised individual; holds
   *  the editable profile (`displayName`, `bio`, `socialLinks`) +
   *  bookkeeping (`createdAt`, `updatedAt`). The on-chain credentials
   *  that map to this person (drep / pool / cc / stake) live in
   *  `identity_links` — read the two together via the
   *  `personId-verifiedAt-index` GSI on `identity_links` to enumerate
   *  every credential one person controls.
   *
   *  Distinct from the legacy `users` table — that's keyed by stake
   *  address and bound to the CIP-30 wallet session. Decision #3
   *  scopes the new model to this dedicated table so the legacy
   *  surface (auth.ts, /auth/verify, /auth/me) is untouched.
   *
   *  See `lib/identityPerson.ts` for the helpers every caller uses. */
  onchainUsers: `${TABLE_PREFIX}onchain_users`,
  /** Decision #3 (2026-06-10) — maps each on-chain credential to a
   *  canonical `personId`.
   *
   *  PK = `identityKey` — namespaced credential string:
   *    `drep:<drepId>` | `pool:<poolId>` | `cc:<ccCred>` |
   *    `stake:<stakeAddr>`. The namespace prefix is load-bearing — it
   *    prevents collision between different credential types that
   *    happen to share a bech32 prefix and makes the credential type
   *    self-describing on read.
   *
   *  Attributes: `personId` (FK), `credentialType`, `verifiedAt`,
   *    `verifiedVia` (`'login' | 'link'`).
   *
   *  GSI `personId-verifiedAt-index` — PK=`personId`, SK=`verifiedAt`
   *  (ISO-8601 sorts chronologically); projection ALL so the
   *  `/auth/onchain/me` aggregation handler can resolve the full
   *  credential set for a person in one single-partition Query. */
  identityLinks: `${TABLE_PREFIX}identity_links`,
  /** Phase 2 committee voting. PK=`voteScope` (`${drepId}#${actionId}`),
   *  SK=`itemKey` ('PROPOSAL' | 'CAST#<wallet>' | 'RATIONALE#DRAFT|LOCK|FINAL'
   *  | 'SUBMISSION' | 'COSIGN#<wallet>'). Sparse GSI `open-epochDeadline-index`
   *  (PK `statusPartition`='OPEN', SK `epochDeadline`) for the open-proposal
   *  view + deadline sweep. See infra/lib/database-stack.ts. */
  committeeVotes: `${TABLE_PREFIX}committee_votes`,
  /** Enforces one-committee-per-wallet (lead OR member) atomically.
   *  PK=`walletAddress` → {drepId, role}. GSI `drepId-index` lists a
   *  committee's membership rows. */
  committeeMembership: `${TABLE_PREFIX}committee_membership`,
  /** Platform-wide flags. PK=`stateKey` (today: 'SAFETY_MODE'). */
  platformState: `${TABLE_PREFIX}platform_state`,
  /** Sprint 4 — community flagging primitive for governance-action
   *  comments. PK=`commentId` (ULID), SK=`flaggerId` (the flagger's
   *  on-chain identity / stake address). One row per (comment, flagger);
   *  duplicate-flag attempts are idempotent at the schema layer via
   *  `putItemIfAbsent`. The matching denormalised counter on the
   *  comment row (`flagCount`) is atomically `ADD`-bumped only on a
   *  fresh insert. See `handlers/comments/flag.ts`. */
  commentFlags: `${TABLE_PREFIX}comment_flags`,
  /** Sprint 4 — community flagging primitive for clubhouse posts.
   *  PK=`postKey` (= `${drepId}#${postId}`, matching the de-inlined
   *  `clubhouse_comments` partition format), SK=`flaggerId`. Same
   *  semantics as `commentFlags` — atomic `ADD` of `flagCount` on the
   *  parent post row only fires on a fresh insert. See
   *  `handlers/clubhouse/flagPost.ts`. */
  clubhousePostFlags: `${TABLE_PREFIX}clubhouse_post_flags`,
  /** Sprint 4 follow-up — community flagging primitive for clubhouse
   *  COMMENTS. PK=`postKey` (= `${drepId}#${postId}`, same shape as
   *  the parent `clubhouse_comments` table), SK=`commentFlagKey`
   *  (= `${commentId}#${flaggerId}`). One row per (comment, flagger);
   *  the schema-level uniqueness comes from the SK tuple. Atomic
   *  `ADD flagCount :one` on the parent `clubhouse_comments` row only
   *  fires on a fresh insert. See `handlers/clubhouse/flagComment.ts`. */
  clubhouseCommentFlags: `${TABLE_PREFIX}clubhouse_comment_flags`,
} as const;

export type TableName = keyof typeof tableNames;

// ---- Generic typed helpers ----

/**
 * BatchGet wrapper that handles the 100-key per-request limit and
 * `UnprocessedKeys` retries. Splits the input keys into chunks of 100,
 * issues one `BatchGetCommand` per chunk, and retries any unprocessed
 * keys (DynamoDB throttling) with linear backoff up to `maxRetries`.
 *
 * Returns items in the same order they were found — duplicates are not
 * possible since DynamoDB de-dupes by primary key. Items are unmarshalled
 * to the document client format. Missing keys are simply absent from the
 * result; the caller is responsible for cross-referencing input vs. output.
 *
 * Used by the directory sync to read existing rows in bulk so it can
 * compare-then-write rather than blindly Put every cycle.
 */
export async function batchGetItems<T extends Record<string, unknown>>(
  tableName: string,
  keys: ReadonlyArray<Record<string, unknown>>,
  options: { maxRetries?: number } = {},
): Promise<T[]> {
  if (keys.length === 0) return [];
  const maxRetries = options.maxRetries ?? 3;
  const out: T[] = [];
  // BatchGetItem caps at 100 keys per call. Chunk the input.
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    let pending: Record<string, unknown>[] = keys.slice(i, i + CHUNK).map((k) => ({ ...k }));
    let attempt = 0;
    while (pending.length > 0) {
      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: { Keys: pending },
        },
      };
      const result = await docClient.send(new BatchGetCommand(params));
      const items = (result.Responses?.[tableName] ?? []) as T[];
      for (const it of items) out.push(it);
      const unprocessed = (result.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<
        string,
        unknown
      >[];
      if (unprocessed.length === 0) break;
      attempt++;
      if (attempt > maxRetries) {
        console.warn(
          `batchGetItems: ${unprocessed.length} unprocessed keys after ${maxRetries} retries; dropping`,
        );
        break;
      }
      // Linear backoff — DynamoDB throttling typically clears in <1s.
      await new Promise((res) => setTimeout(res, 100 * attempt));
      pending = unprocessed;
    }
  }
  return out;
}

export async function getItem<T extends Record<string, unknown>>(
  tableName: string,
  key: Record<string, unknown>,
): Promise<T | undefined> {
  const params: GetCommandInput = {
    TableName: tableName,
    Key: key,
  };
  const result = await docClient.send(new GetCommand(params));
  return result.Item as T | undefined;
}

export async function putItem<T extends Record<string, unknown>>(
  tableName: string,
  item: T,
  conditionExpression?: string,
  expressionAttributeNames?: Record<string, string>,
): Promise<void> {
  const params: PutCommandInput = {
    TableName: tableName,
    Item: item,
    ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    ...(expressionAttributeNames
      ? { ExpressionAttributeNames: expressionAttributeNames }
      : {}),
  };
  await docClient.send(new PutCommand(params));
}

/**
 * Best-effort append-only write — Put with a `ConditionExpression` that
 * fails if the (PK, SK) tuple already exists. The promise resolves
 * regardless of which outcome happened so a caller doing a bulk pass can
 * count successes and skips without try/catch around every call.
 *
 * Returns:
 *   - `'written'` — the row was newly inserted
 *   - `'skipped'` — the row already existed (ConditionalCheckFailedException)
 *   - `'errored'` — any other failure path, with `error` populated
 *
 * Used by the `governance-intake` sync to append per-vote rows without
 * re-writing the same vote on every cycle (~24k rows on mainnet today; a
 * blind Put loop would burn ~24k WCU/cycle on data that almost never
 * changes).
 *
 * Note: the SDK throws `ConditionalCheckFailedException` for the skip
 * case; we recognise it by name to avoid coupling to an error class
 * import. The cost of a skipped write is still one WRU (DynamoDB charges
 * for the conditional check), but the alternative — Get-then-Put — would
 * cost ~1.5x more in RCU+WCU and add a round-trip.
 */
export async function putItemIfAbsent<T extends Record<string, unknown>>(
  tableName: string,
  item: T,
  /** Names of the partition key (and optionally sort key) attributes. We
   *  build the ConditionExpression from these so the helper works on any
   *  table without hardcoding key names. */
  keyAttributes: { partitionKey: string; sortKey?: string },
): Promise<{ outcome: 'written' | 'skipped' | 'errored'; error?: unknown }> {
  const conditionParts: string[] = [`attribute_not_exists(#pk)`];
  const names: Record<string, string> = { '#pk': keyAttributes.partitionKey };
  if (keyAttributes.sortKey) {
    conditionParts.push(`attribute_not_exists(#sk)`);
    names['#sk'] = keyAttributes.sortKey;
  }
  const params: PutCommandInput = {
    TableName: tableName,
    Item: item,
    ConditionExpression: conditionParts.join(' AND '),
    ExpressionAttributeNames: names,
  };
  try {
    await docClient.send(new PutCommand(params));
    return { outcome: 'written' };
  } catch (err) {
    // The SDK throws a specific error with `name === 'ConditionalCheckFailedException'`
    // when the condition fails (row already exists). Anything else is a real
    // failure we surface to the caller.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { outcome: 'skipped' };
    }
    return { outcome: 'errored', error: err };
  }
}

export async function deleteItem(
  tableName: string,
  key: Record<string, unknown>,
  conditionExpression?: string,
  expressionAttributeNames?: Record<string, string>,
): Promise<void> {
  const params: DeleteCommandInput = {
    TableName: tableName,
    Key: key,
    ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    ...(expressionAttributeNames
      ? { ExpressionAttributeNames: expressionAttributeNames }
      : {}),
  };
  await docClient.send(new DeleteCommand(params));
}

export interface QueryOptions {
  indexName?: string;
  keyConditionExpression: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
  filterExpression?: string;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  scanIndexForward?: boolean;
  /** Optional projection of attributes to return. Useful for Query
   *  paths that only need a subset of fields — e.g. the rail ranker
   *  projects `(authorWallet, createdAt, parentCommentId)` and skips
   *  the comment body to avoid pulling kilobytes of text it never
   *  reads. */
  projectionExpression?: string;
}

export interface QueryResult<T> {
  items: T[];
  lastEvaluatedKey?: Record<string, unknown>;
  count: number;
}

export async function queryItems<T extends Record<string, unknown>>(
  tableName: string,
  options: QueryOptions,
): Promise<QueryResult<T>> {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: options.keyConditionExpression,
    ExpressionAttributeValues: options.expressionAttributeValues,
    ...(options.indexName ? { IndexName: options.indexName } : {}),
    ...(options.expressionAttributeNames
      ? { ExpressionAttributeNames: options.expressionAttributeNames }
      : {}),
    ...(options.filterExpression ? { FilterExpression: options.filterExpression } : {}),
    ...(options.limit ? { Limit: options.limit } : {}),
    ...(options.exclusiveStartKey ? { ExclusiveStartKey: options.exclusiveStartKey } : {}),
    ...(options.scanIndexForward !== undefined
      ? { ScanIndexForward: options.scanIndexForward }
      : {}),
    ...(options.projectionExpression
      ? { ProjectionExpression: options.projectionExpression }
      : {}),
  };
  const result = await docClient.send(new QueryCommand(params));
  return {
    items: (result.Items ?? []) as T[],
    lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,
    count: result.Count ?? 0,
  };
}

export interface ScanOptions {
  filterExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  /** Optional projection of attributes to return. Useful for scans that
   *  only need the key + a couple of fields. */
  projectionExpression?: string;
}

/**
 * Scan a table with optional filter. Use sparingly — Scans read every
 * partition and bill for every item examined, not just returned. The
 * DRep directory is small (~2000 items today) so a filtered Scan for
 * search is cheaper than maintaining a full-text index.
 */
export async function scanItems<T extends Record<string, unknown>>(
  tableName: string,
  options: ScanOptions = {},
): Promise<QueryResult<T>> {
  const params: ScanCommandInput = {
    TableName: tableName,
    ...(options.filterExpression ? { FilterExpression: options.filterExpression } : {}),
    ...(options.expressionAttributeNames
      ? { ExpressionAttributeNames: options.expressionAttributeNames }
      : {}),
    ...(options.expressionAttributeValues
      ? { ExpressionAttributeValues: options.expressionAttributeValues }
      : {}),
    ...(options.limit ? { Limit: options.limit } : {}),
    ...(options.exclusiveStartKey ? { ExclusiveStartKey: options.exclusiveStartKey } : {}),
    ...(options.projectionExpression
      ? { ProjectionExpression: options.projectionExpression }
      : {}),
  };
  const result = await docClient.send(new ScanCommand(params));
  return {
    items: (result.Items ?? []) as T[],
    lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,
    count: result.Count ?? 0,
  };
}

export async function updateItem(
  tableName: string,
  key: Record<string, unknown>,
  updateExpression: string,
  expressionAttributeNames: Record<string, string>,
  expressionAttributeValues: Record<string, unknown>,
  conditionExpression?: string,
): Promise<void> {
  const params: UpdateCommandInput = {
    TableName: tableName,
    Key: key,
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
  };
  await docClient.send(new UpdateCommand(params));
}

export async function transactWrite(
  items: TransactWriteCommandInput['TransactItems'],
): Promise<void> {
  await docClient.send(new TransactWriteCommand({ TransactItems: items }));
}

// ---- Domain-specific helpers ----

export function buildUpdateExpression(
  fields: Record<string, unknown>,
): {
  updateExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
} {
  const setClauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#${key}`;
    const valueToken = `:${key}`;
    setClauses.push(`${nameToken} = ${valueToken}`);
    names[nameToken] = key;
    values[valueToken] = value;
  }

  return {
    updateExpression: `SET ${setClauses.join(', ')}`,
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  };
}
