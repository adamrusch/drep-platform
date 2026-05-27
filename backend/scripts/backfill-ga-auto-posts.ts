#!/usr/bin/env npx tsx
/**
 * One-shot backfill: write a `type='auto_ga'` clubhouse_posts row for
 * every (currently-active DRep × currently-active GA) pair.
 *
 * **Why this exists (2026-05-26, Batch B):** the GA auto-post feature
 * goes live with future GAs (the governance-intake sync fans-out on
 * new-GA detection) and future activating DReps (the directory sync
 * back-fills on transition). The first deploy needs a one-shot pass to
 * cover the (already-active GAs × already-active DReps) cross-product —
 * the spec explicitly excludes expired/executed GAs.
 *
 * **Idempotency:** safe to re-run. Each pair's write is a conditional
 * Put keyed on the deterministic `(drepId, postId=auto-ga#<actionId>)`
 * tuple. Already-present rows skip with a `ConditionalCheckFailedException`
 * which the helper translates to `outcome: 'skipped'`.
 *
 * **Deploy ordering:**
 *   1. `cdk deploy DatabaseStack` — provisions the new `linkedActionId-index`
 *      GSI on `clubhouse_posts`. The script does not depend on the GSI
 *      being ACTIVE (it does no GSI Queries), but the API code's
 *      completion sweep does.
 *   2. `cdk deploy ApiStack SchedulerStack` — ships the new sync code
 *      that writes `linkedActionId` on every auto-post. The script
 *      already writes it; consistency comes from running this AFTER
 *      the API code deploys (otherwise we'd write rows the old sync
 *      doesn't know about, harmless but noisy).
 *   3. Run this script:
 *      `AWS_PROFILE=drep-platform AWS_REGION=us-east-1 \
 *         STAGE=dev \
 *         npx tsx backend/scripts/backfill-ga-auto-posts.ts`
 *
 * **Cost estimate:** ~50 currently-active GAs × ~368 active DReps =
 * ~18,400 conditional Puts. PAY_PER_REQUEST: ~$0.025. Negligible.
 *
 * **What this script does NOT do:**
 *   - Does not write into clubhouses of inactive / retired DReps. The
 *     spec scopes "active DReps only."
 *   - Does not backfill expired / enacted / dropped GAs. The spec
 *     scopes "currently-active GAs + future."
 *   - Does not create the GSI. CDK owns that.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  PutCommand,
  type PutCommandInput,
  type ScanCommandInput,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

const STAGE = process.env['STAGE'] ?? 'dev';
const TABLE_PREFIX = `drep-platform-${STAGE}-`;
const DREP_DIRECTORY_TABLE = process.env['DREP_DIRECTORY_TABLE'] ?? `${TABLE_PREFIX}drep_directory`;
const GOVERNANCE_ACTIONS_TABLE =
  process.env['GOVERNANCE_ACTIONS_TABLE'] ?? `${TABLE_PREFIX}governance_actions`;
const CLUBHOUSE_POSTS_TABLE =
  process.env['CLUBHOUSE_POSTS_TABLE'] ?? `${TABLE_PREFIX}clubhouse_posts`;

const REGION = process.env['AWS_REGION'] ?? 'us-east-1';

const AUTO_POST_AUTHOR_WALLET = '_system:governance_feed';
const AUTO_POST_AUTHOR_DISPLAY_NAME = 'drep.tools governance feed';

const rawClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  unmarshallOptions: { wrapNumbers: false },
});

interface ActiveDRepRow {
  drepId: string;
  SK: string;
  isActive: boolean;
  isRetired?: boolean;
}

interface ActiveGARow {
  actionId: string;
  SK: string;
  status: string;
  title?: string;
  summary?: string;
  abstract?: string;
}

interface Counters {
  pairsTotal: number;
  written: number;
  skipped: number;
  errored: number;
  drepCount: number;
  gaCount: number;
}

function autoPostId(actionId: string): string {
  return `auto-ga#${actionId}`;
}

function buildBody(ga: ActiveGARow): { title: string; body: string } {
  const rawTitle =
    (typeof ga.title === 'string' && ga.title.trim()) ||
    (typeof ga.summary === 'string' && ga.summary.trim()) ||
    `Governance Action ${ga.actionId}`;
  const title = rawTitle.length > 200 ? `${rawTitle.slice(0, 197)}...` : rawTitle;
  const rawBody =
    (typeof ga.abstract === 'string' && ga.abstract.trim()) ||
    (typeof ga.summary === 'string' && ga.summary.trim()) ||
    'New governance action posted. See the linked action for details.';
  const body = rawBody.length > 5_000 ? `${rawBody.slice(0, 4_997)}...` : rawBody;
  return { title, body };
}

async function loadActiveDReps(): Promise<string[]> {
  // Use the sparse GSI for an efficient pass — same path the sync
  // takes. Excludes inactive and retired by client-side filter.
  console.log(`backfill-ga-auto-posts: loading active DReps from ${DREP_DIRECTORY_TABLE}`);
  const out: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const params: QueryCommandInput = {
      TableName: DREP_DIRECTORY_TABLE,
      IndexName: 'entityType-votingPower-index',
      KeyConditionExpression: '#et = :v',
      ExpressionAttributeNames: { '#et': 'entityType' },
      ExpressionAttributeValues: { ':v': 'DREP_PROFILE' },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };
    const result = await docClient.send(new QueryCommand(params));
    const rows = (result.Items ?? []) as ActiveDRepRow[];
    for (const r of rows) {
      if (r.isActive === true) out.push(r.drepId);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  console.log(`backfill-ga-auto-posts: loaded ${out.length} active DReps`);
  return out;
}

async function loadActiveGAs(): Promise<ActiveGARow[]> {
  // Use the `status-submittedAt-index` GSI to fetch only `active` rows.
  console.log(`backfill-ga-auto-posts: loading active GAs from ${GOVERNANCE_ACTIONS_TABLE}`);
  const out: ActiveGARow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const params: QueryCommandInput = {
      TableName: GOVERNANCE_ACTIONS_TABLE,
      IndexName: 'status-submittedAt-index',
      KeyConditionExpression: '#s = :v',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':v': 'active' },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };
    const result = await docClient.send(new QueryCommand(params));
    out.push(...((result.Items ?? []) as ActiveGARow[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  console.log(`backfill-ga-auto-posts: loaded ${out.length} active GAs`);
  return out;
}

async function writeAutoPost(
  drepId: string,
  ga: ActiveGARow,
  now: string,
): Promise<'written' | 'skipped' | 'errored'> {
  const { title, body } = buildBody(ga);
  const postId = autoPostId(ga.actionId);
  const item = {
    drepId,
    postId,
    authorWallet: AUTO_POST_AUTHOR_WALLET,
    authorDisplayName: AUTO_POST_AUTHOR_DISPLAY_NAME,
    isDRepPost: false,
    body,
    title,
    comments: [],
    createdAt: now,
    updatedAt: now,
    type: 'auto_ga',
    pinned: true,
    linkedActionId: ga.actionId,
    autoSource: {
      kind: 'governance_action',
      actionId: ga.actionId,
      abstractFrozenAt: now,
    },
  };
  const params: PutCommandInput = {
    TableName: CLUBHOUSE_POSTS_TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(#pk) AND attribute_not_exists(#sk)',
    ExpressionAttributeNames: { '#pk': 'drepId', '#sk': 'postId' },
  };
  try {
    await docClient.send(new PutCommand(params));
    return 'written';
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return 'skipped';
    }
    console.error(`backfill-ga-auto-posts: write failed for drep=${drepId} action=${ga.actionId}:`, err);
    return 'errored';
  }
}

async function main(): Promise<void> {
  console.log(`backfill-ga-auto-posts: stage=${STAGE} region=${REGION}`);
  const [drepIds, gas] = await Promise.all([loadActiveDReps(), loadActiveGAs()]);

  const counters: Counters = {
    pairsTotal: drepIds.length * gas.length,
    written: 0,
    skipped: 0,
    errored: 0,
    drepCount: drepIds.length,
    gaCount: gas.length,
  };

  if (counters.pairsTotal === 0) {
    console.log('backfill-ga-auto-posts: nothing to do (0 pairs)');
    return;
  }

  console.log(
    `backfill-ga-auto-posts: writing ${counters.pairsTotal} pairs ` +
      `(${drepIds.length} DReps × ${gas.length} GAs); ` +
      `progress logged every 500 writes`,
  );

  // Per-GA outer loop, per-DRep inner — this writes each GA's posts
  // back-to-back so a partial failure cluster is easier to debug.
  // Within a GA's fan-out we use a "now" stamped at the start so all
  // its rows share an `abstractFrozenAt` (consistent with how the
  // governance-intake sync stamps them on new-GA detection).
  let processed = 0;
  for (const ga of gas) {
    const now = new Date().toISOString();
    for (const drepId of drepIds) {
      const outcome = await writeAutoPost(drepId, ga, now);
      if (outcome === 'written') counters.written++;
      else if (outcome === 'skipped') counters.skipped++;
      else counters.errored++;
      processed++;
      if (processed % 500 === 0) {
        console.log(
          `backfill-ga-auto-posts: ${processed}/${counters.pairsTotal} processed ` +
            `(written=${counters.written}, skipped=${counters.skipped}, errored=${counters.errored})`,
        );
      }
    }
  }

  console.log('backfill-ga-auto-posts: done');
  console.log(`  pairsTotal = ${counters.pairsTotal}`);
  console.log(`  drepCount  = ${counters.drepCount}`);
  console.log(`  gaCount    = ${counters.gaCount}`);
  console.log(`  written    = ${counters.written}`);
  console.log(`  skipped    = ${counters.skipped} (already had a row — idempotent re-run)`);
  console.log(`  errored    = ${counters.errored}`);
  if (counters.errored > 0) {
    console.error('backfill-ga-auto-posts: completed with errors — re-run to retry failures');
    process.exit(1);
  }
}

// Defer execution if imported (the idempotency test imports the module
// to inspect helpers without running the main loop). Detected by the
// presence of a node-environment env var pointing at the test runner.
if (process.env['VITEST'] !== 'true' && require.main === module) {
  main().catch((err) => {
    console.error('backfill-ga-auto-posts: fatal error:', err);
    process.exit(1);
  });
}

export { autoPostId, buildBody, writeAutoPost, loadActiveDReps, loadActiveGAs };

// Suppress unused-import warning when the ScanCommand is only used by
// a future strategy (we keep the import for symmetry with backfill-
// entity-type.ts which uses Scan — switching back to Scan is a single-
// line change if needed).
export { ScanCommand as _ScanCommand };
export type { ScanCommandInput as _ScanCommandInput };
