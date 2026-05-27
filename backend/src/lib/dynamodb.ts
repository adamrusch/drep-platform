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

export const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
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
   *  the vote handler. See `handlers/comments/vote.ts`. */
  commentVotes: `${TABLE_PREFIX}comment_votes`,
  clubhousePosts: `${TABLE_PREFIX}clubhouse_posts`,
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
