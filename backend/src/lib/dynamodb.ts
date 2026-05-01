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
  governanceActions: `${TABLE_PREFIX}governance_actions`,
  comments: `${TABLE_PREFIX}comments`,
  clubhousePosts: `${TABLE_PREFIX}clubhouse_posts`,
  auditLog: `${TABLE_PREFIX}audit_log`,
  authNonces: `${TABLE_PREFIX}auth_nonces`,
} as const;

export type TableName = keyof typeof tableNames;

// ---- Generic typed helpers ----

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
