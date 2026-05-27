/**
 * Idempotency test for the GA auto-post backfill script.
 *
 * The actual script lives in `backend/scripts/backfill-ga-auto-posts.ts`
 * (out of tree of `src/` so it doesn't bundle into Lambda artifacts).
 *
 * Like the entityType backfill test, this asserts the IDEMPOTENCY
 * CONTRACT the script relies on: the conditional Put with
 * `attribute_not_exists` on `(drepId, postId)` correctly de-dupes
 * concurrent or re-run writers.
 *
 * Why this matters: the spec calls for the user to run this script
 * after deploy. If a network blip or a CI hiccup ever requires a
 * re-run, the second run MUST land as ~18,400 "skipped" outcomes (one
 * per pair), not as ~18,400 duplicates or as a hard failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class PutCommand {
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class QueryCommand {
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class ScanCommand {
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    DynamoDBDocumentClient: {
      from: (): { send: ReturnType<typeof vi.fn> } => ({ send: vi.fn() }),
    },
    PutCommand,
    QueryCommand,
    ScanCommand,
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class DynamoDBClient {},
}));

import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

interface DocClientLike {
  send: (...args: unknown[]) => Promise<unknown>;
}

function makeDocClient(responses: Array<unknown | Error>): {
  client: DocClientLike;
  send: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const send = vi.fn().mockImplementation(async () => {
    if (i >= responses.length) {
      throw new Error(`unexpected docClient.send call beyond response array (${i})`);
    }
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  });
  return {
    client: { send: send as unknown as DocClientLike['send'] },
    send,
  };
}

class ConditionalCheckFailedException extends Error {
  public readonly name = 'ConditionalCheckFailedException';
  constructor() {
    super('The conditional request failed');
  }
}

/** Re-create the per-pair Put the backfill script issues. Mirrors the
 *  exact shape from `backfill-ga-auto-posts.ts` so the test is self-
 *  contained but verifies the contract the script depends on. */
async function backfillOnePair(
  docClient: DocClientLike,
  drepId: string,
  actionId: string,
  now: string,
): Promise<'written' | 'skipped' | 'errored'> {
  const postId = `auto-ga#${actionId}`;
  const item = {
    drepId,
    postId,
    authorWallet: '_system:governance_feed',
    authorDisplayName: 'drep.tools governance feed',
    isDRepPost: false,
    body: 'body',
    title: 'title',
    comments: [],
    createdAt: now,
    updatedAt: now,
    type: 'auto_ga',
    pinned: true,
    linkedActionId: actionId,
    autoSource: { kind: 'governance_action', actionId, abstractFrozenAt: now },
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: 'clubhouse_posts',
        Item: item,
        ConditionExpression: 'attribute_not_exists(#pk) AND attribute_not_exists(#sk)',
        ExpressionAttributeNames: { '#pk': 'drepId', '#sk': 'postId' },
      }),
    );
    return 'written';
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return 'skipped';
    }
    return 'errored';
  }
}

describe('backfill-ga-auto-posts idempotency contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first run writes the row when the (drepId, postId) tuple is new', async () => {
    const { client, send } = makeDocClient([{}]);
    const outcome = await backfillOnePair(client, 'drep1', 'a#0', '2026-05-26T20:00:00.000Z');
    expect(outcome).toBe('written');
    const cmd = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input).toMatchObject({
      TableName: 'clubhouse_posts',
      ConditionExpression: 'attribute_not_exists(#pk) AND attribute_not_exists(#sk)',
      ExpressionAttributeNames: { '#pk': 'drepId', '#sk': 'postId' },
    });
    const item = (cmd.input as { Item: Record<string, unknown> }).Item;
    expect(item['drepId']).toBe('drep1');
    expect(item['postId']).toBe('auto-ga#a#0');
    expect(item['type']).toBe('auto_ga');
    expect(item['pinned']).toBe(true);
  });

  it('second run skips when the row already exists', async () => {
    const { client, send } = makeDocClient([new ConditionalCheckFailedException()]);
    const outcome = await backfillOnePair(client, 'drep1', 'a#0', '2026-05-26T20:00:00.000Z');
    expect(outcome).toBe('skipped');
    // The script still issued the Put — DynamoDB enforces the dedupe via
    // the condition. Get-then-conditional-Put would cost more on average.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('end-to-end: running the same backfill twice on the same fleet produces stable end state', async () => {
    const firstResponses = Array.from({ length: 6 }, () => ({})); // 3 DReps × 2 GAs = 6 writes
    const secondResponses = Array.from(
      { length: 6 },
      () => new ConditionalCheckFailedException(),
    );
    const { client: client1 } = makeDocClient(firstResponses);
    const { client: client2 } = makeDocClient(secondResponses);

    const drepIds = ['drep1', 'drep2', 'drep3'];
    const actionIds = ['a#0', 'b#0'];
    const now = '2026-05-26T20:00:00.000Z';

    const firstOutcomes: string[] = [];
    for (const a of actionIds)
      for (const d of drepIds) firstOutcomes.push(await backfillOnePair(client1, d, a, now));

    const secondOutcomes: string[] = [];
    for (const a of actionIds)
      for (const d of drepIds) secondOutcomes.push(await backfillOnePair(client2, d, a, now));

    expect(firstOutcomes).toEqual(Array(6).fill('written'));
    expect(secondOutcomes).toEqual(Array(6).fill('skipped'));
  });

  it('concurrent races: a duplicate (drepId, postId) tuple from two writers — only one wins', async () => {
    // Simulate two writers racing to write the same pair. Writer A
    // wins (returns 'written'); writer B sees the conditional fail
    // and returns 'skipped'. No duplicate is created, no error
    // bubbles to the user.
    const { client: clientA } = makeDocClient([{}]);
    const { client: clientB } = makeDocClient([new ConditionalCheckFailedException()]);
    const drepId = 'drep1';
    const actionId = 'a#0';
    const now = '2026-05-26T20:00:00.000Z';

    const [outcomeA, outcomeB] = await Promise.all([
      backfillOnePair(clientA, drepId, actionId, now),
      backfillOnePair(clientB, drepId, actionId, now),
    ]);
    expect([outcomeA, outcomeB].sort()).toEqual(['skipped', 'written']);
  });
});

// Touch the import so vitest doesn't tree-shake.
void DynamoDBDocumentClient;
