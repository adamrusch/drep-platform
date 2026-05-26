#!/usr/bin/env npx tsx
/**
 * One-shot backfill script: populate the `entityType` attribute on every
 * existing PROFILE row in the `drep_directory` table.
 *
 * **Why this exists (2026-05-26):** the directory list handler used to
 * Scan the entire table with a FilterExpression for `SK = 'PROFILE'`.
 * With the daily `drep-voting-power-history` sync writing
 * `SK='POWER#NNNNNN'` sub-rows under the same `drepId` partition, the
 * table grew to ~101k items for ~1623 PROFILE rows — and the Scan's
 * raw-item budget was being exhausted reading POWER rows, returning
 * only ~800 of 1623 PROFILE rows. DReps were silently missing from the
 * directory.
 *
 * Fix: a sparse GSI on the `drep_directory` table, partitioned on a new
 * `entityType` attribute that's present only on PROFILE rows. The
 * directory-sync code now writes `entityType='DREP_PROFILE'` on every
 * Put, but existing rows synced before the deploy don't carry it — they
 * need this backfill before the new read path will return them.
 *
 * **Deploy ordering:**
 *   1. `cdk deploy DatabaseStack` — provisions the new GSI (DynamoDB
 *      starts the asynchronous index build immediately, can take minutes
 *      to hours for production tables; check `aws dynamodb describe-table
 *      --table-name <name>` for `IndexStatus: 'ACTIVE'`).
 *   2. Run this script: `AWS_PROFILE=drep-platform AWS_REGION=us-east-1
 *      npx tsx backend/scripts/backfill-entity-type.ts`
 *   3. Wait for the GSI to be `ACTIVE` (the script does NOT wait — it
 *      writes the attribute, and DynamoDB will then auto-include the row
 *      in the GSI's incremental population pass).
 *   4. `cdk deploy ApiStack SchedulerStack` — ships the new read path
 *      (`list.ts` Query against the GSI) AND the updated sync
 *      (`drep-directory.ts` writes the attribute on every cycle going
 *      forward, including injecting predefined DReps).
 *
 * **Idempotency:** safe to re-run. Rows that already carry the attribute
 * are detected via the `attribute_not_exists` condition on UpdateItem
 * and skipped with a no-op — DynamoDB does not bill failed-condition
 * UpdateItem operations at WCU rates (they cost 1 RRU equivalent each).
 *
 * **Cost estimate:** ~1623 PROFILE rows × 1 WCU/write = ~1623 WCU one-shot.
 * Negligible on PAY_PER_REQUEST. On re-runs (idempotent) the cost is
 * ~1623 conditional checks ≈ ~10 RRU equivalent.
 *
 * **What this script does NOT do:**
 *   - Does not create or modify the GSI itself — that's CDK's job.
 *   - Does not migrate POWER rows (`SK='POWER#NNNNNN'`) — those rows
 *     intentionally lack the `entityType` attribute. The GSI is sparse
 *     and excludes them by design.
 *   - Does not run automatically — it's a one-shot the user invokes
 *     manually after the CDK deploy.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type ScanCommandInput,
  UpdateCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';

const TABLE_NAME =
  process.env['DREP_DIRECTORY_TABLE'] ??
  `drep-platform-${process.env['STAGE'] ?? 'dev'}-drep_directory`;

const REGION = process.env['AWS_REGION'] ?? 'us-east-1';

const ENTITY_TYPE_PROFILE = 'DREP_PROFILE';

const rawClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  unmarshallOptions: { wrapNumbers: false },
});

interface DirectoryRow {
  drepId: string;
  SK: string;
  entityType?: string;
}

interface Counters {
  totalScanned: number;
  profileRows: number;
  alreadyHadAttribute: number;
  updated: number;
  errors: number;
}

async function main(): Promise<void> {
  console.log(`backfill-entity-type: target table = ${TABLE_NAME} (region ${REGION})`);
  console.log(
    `backfill-entity-type: will set entityType='${ENTITY_TYPE_PROFILE}' on every row with SK='PROFILE' that doesn't already have it`,
  );

  const counters: Counters = {
    totalScanned: 0,
    profileRows: 0,
    alreadyHadAttribute: 0,
    updated: 0,
    errors: 0,
  };

  // Scan the entire table. Filter to SK='PROFILE' server-side so we don't
  // pull POWER rows over the wire (they'd be discarded anyway). We project
  // only the keys + entityType — that's all we need to decide whether to
  // write, and it minimizes Scan response payload bytes.
  let cursor: Record<string, unknown> | undefined;
  let page = 0;
  do {
    page += 1;
    const params: ScanCommandInput = {
      TableName: TABLE_NAME,
      FilterExpression: '#sk = :profileSK',
      ProjectionExpression: '#drepId, #sk, #et',
      ExpressionAttributeNames: {
        '#sk': 'SK',
        '#drepId': 'drepId',
        '#et': 'entityType',
      },
      ExpressionAttributeValues: { ':profileSK': 'PROFILE' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    };
    const result = await docClient.send(new ScanCommand(params));
    counters.totalScanned += result.ScannedCount ?? 0;
    const items = (result.Items ?? []) as DirectoryRow[];
    counters.profileRows += items.length;
    console.log(
      `backfill-entity-type: page ${page} — scanned ${result.ScannedCount} raw items, ${items.length} PROFILE rows`,
    );

    // Per-row UpdateItem with a conditional that no-ops if entityType
    // already exists. We loop sequentially (one UpdateItem at a time) on
    // purpose — 1623 row writes finish in ~30s sequentially and Lambda-
    // adjacent throttling is not a concern at this scale. Parallelizing
    // would risk burst-limiting PAY_PER_REQUEST capacity for zero
    // user-visible benefit.
    for (const row of items) {
      try {
        const updateParams: UpdateCommandInput = {
          TableName: TABLE_NAME,
          Key: { drepId: row.drepId, SK: 'PROFILE' },
          UpdateExpression: 'SET #et = :v',
          ConditionExpression: 'attribute_not_exists(#et)',
          ExpressionAttributeNames: { '#et': 'entityType' },
          ExpressionAttributeValues: { ':v': ENTITY_TYPE_PROFILE },
        };
        await docClient.send(new UpdateCommand(updateParams));
        counters.updated += 1;
      } catch (err) {
        // ConditionalCheckFailedException = row already has the attribute.
        // That's an idempotent re-run hit; count it and continue.
        const name = (err as { name?: string }).name;
        if (name === 'ConditionalCheckFailedException') {
          counters.alreadyHadAttribute += 1;
        } else {
          counters.errors += 1;
          console.error(
            `backfill-entity-type: failed to update drepId=${row.drepId}:`,
            err,
          );
        }
      }
    }

    cursor = result.LastEvaluatedKey;
  } while (cursor);

  console.log('backfill-entity-type: done');
  console.log(
    `  totalScanned       = ${counters.totalScanned} (raw items including POWER rows filtered server-side)`,
  );
  console.log(`  profileRows        = ${counters.profileRows}`);
  console.log(`  alreadyHadAttribute = ${counters.alreadyHadAttribute}`);
  console.log(`  updated            = ${counters.updated}`);
  console.log(`  errors             = ${counters.errors}`);
  if (counters.errors > 0) {
    console.error('backfill-entity-type: completed with errors — re-run to retry failures');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('backfill-entity-type: fatal error:', err);
  process.exit(1);
});
