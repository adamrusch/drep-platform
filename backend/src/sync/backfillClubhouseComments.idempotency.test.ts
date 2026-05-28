/**
 * Idempotency + correctness tests for the Clubhouse-comments backfill
 * script.
 *
 * The actual script lives at
 * `backend/scripts/backfill-clubhouse-comments.ts` (out of `src/` so
 * it doesn't bundle into Lambda artifacts). The pure helpers it
 * exports (`computeDepths`, `maxCreatedAt`, `estimateRowSize`,
 * `postKeyFor`, `STUCK_POST_SIZE_THRESHOLD_BYTES`) are importable for
 * direct unit testing — we mock the AWS SDK so the import doesn't
 * actually try to talk to DynamoDB.
 *
 * Why this matters: the script runs ONCE during the migration and
 * MUST be safe to re-run. The conditional Put with
 * `attribute_not_exists(commentId)` is the idempotency contract; this
 * file pins it alongside the helper-function correctness checks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Block the SDK imports the script file does at top-level. We don't
// invoke the script's main(); we only call the exported pure helpers.
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class PutCommand {
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class UpdateCommand {
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
    UpdateCommand,
    ScanCommand,
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class DynamoDBClient {},
}));

import {
  STUCK_POST_SIZE_THRESHOLD_BYTES,
  clubhouseCommentsPostKeyFor as postKeyFor,
  computeClubhouseCommentDepths as computeDepths,
  estimateClubhousePostRowSize as estimateRowSize,
  maxClubhouseCommentCreatedAt as maxCreatedAt,
} from '../lib/backfill-clubhouse-comments';

interface DocClientLike {
  send: (...args: unknown[]) => Promise<unknown>;
}

import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

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

/** Re-create the per-comment Put the backfill script issues. Mirrors
 *  the shape from `backfill-clubhouse-comments.ts` so the test pins
 *  the idempotency contract the script depends on. */
async function backfillOneComment(
  docClient: DocClientLike,
  drepId: string,
  postId: string,
  comment: {
    commentId: string;
    authorWallet: string;
    body: string;
    createdAt: string;
    parentCommentId?: string;
  },
  depth: 0 | 1 | 2,
): Promise<'written' | 'skipped' | 'errored'> {
  const item = {
    postKey: postKeyFor(drepId, postId),
    commentId: comment.commentId,
    drepId,
    postId,
    authorWallet: comment.authorWallet,
    body: comment.body,
    createdAt: comment.createdAt,
    depth,
    ...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: 'clubhouse_comments',
        Item: item,
        ConditionExpression: 'attribute_not_exists(commentId)',
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

describe('backfill-clubhouse-comments — postKeyFor', () => {
  it('joins drepId and postId with `#`', () => {
    expect(postKeyFor('drep1', 'post1')).toBe('drep1#post1');
  });
});

describe('backfill-clubhouse-comments — computeDepths', () => {
  it('returns depth 0 for every top-level comment', () => {
    const depths = computeDepths([
      { commentId: 'a', authorWallet: 'w', body: 'b', createdAt: '2026-01-01' },
      { commentId: 'b', authorWallet: 'w', body: 'b', createdAt: '2026-01-01' },
    ]);
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(0);
  });

  it('returns depth 1 for a reply to a top-level comment', () => {
    const depths = computeDepths([
      { commentId: 'top', authorWallet: 'w', body: 'b', createdAt: '2026-01-01' },
      {
        commentId: 'reply',
        authorWallet: 'w',
        body: 'b',
        createdAt: '2026-01-02',
        parentCommentId: 'top',
      },
    ]);
    expect(depths.get('top')).toBe(0);
    expect(depths.get('reply')).toBe(1);
  });

  it('returns depth 2 for a sub-reply to a reply', () => {
    const depths = computeDepths([
      { commentId: 'top', authorWallet: 'w', body: 'b', createdAt: '2026-01-01' },
      {
        commentId: 'reply',
        authorWallet: 'w',
        body: 'b',
        createdAt: '2026-01-02',
        parentCommentId: 'top',
      },
      {
        commentId: 'subreply',
        authorWallet: 'w',
        body: 'b',
        createdAt: '2026-01-03',
        parentCommentId: 'reply',
      },
    ]);
    expect(depths.get('top')).toBe(0);
    expect(depths.get('reply')).toBe(1);
    expect(depths.get('subreply')).toBe(2);
  });

  it('clamps corrupt depth-3+ chains to 2 (defensive against bad inline data)', () => {
    const depths = computeDepths([
      { commentId: 'top', authorWallet: 'w', body: 'b', createdAt: '2026-01-01' },
      {
        commentId: 'r1',
        authorWallet: 'w',
        body: 'b',
        createdAt: '2026-01-02',
        parentCommentId: 'top',
      },
      {
        commentId: 'r2',
        authorWallet: 'w',
        body: 'b',
        createdAt: '2026-01-03',
        parentCommentId: 'r1',
      },
      {
        commentId: 'r3', // depth would be 3 — the live handler rejects writes here, but data could be corrupt.
        authorWallet: 'w',
        body: 'b',
        createdAt: '2026-01-04',
        parentCommentId: 'r2',
      },
    ]);
    expect(depths.get('r3')).toBe(2); // clamped
  });

  it('handles orphan parents (parent missing from the array) without crashing', () => {
    const depths = computeDepths([
      {
        commentId: 'orphan',
        authorWallet: 'w',
        body: 'b',
        createdAt: '2026-01-02',
        parentCommentId: 'never-existed',
      },
    ]);
    // The walk steps to a non-existent parent, increments once, then
    // breaks. Result: depth 1. This matches the live handler's
    // defensive walk — `getItem` returning undefined falls through.
    expect(depths.get('orphan')).toBe(1);
  });
});

describe('backfill-clubhouse-comments — maxCreatedAt', () => {
  it('returns undefined for an empty list', () => {
    expect(maxCreatedAt([])).toBeUndefined();
  });

  it('returns the maximum ISO-8601 timestamp', () => {
    expect(
      maxCreatedAt([
        { commentId: 'a', authorWallet: 'w', body: 'b', createdAt: '2026-01-01T00:00:00.000Z' },
        { commentId: 'b', authorWallet: 'w', body: 'b', createdAt: '2026-01-03T00:00:00.000Z' },
        { commentId: 'c', authorWallet: 'w', body: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ]),
    ).toBe('2026-01-03T00:00:00.000Z');
  });

  it('ignores entries with non-string createdAt', () => {
    expect(
      maxCreatedAt([
        { commentId: 'a', authorWallet: 'w', body: 'b', createdAt: '2026-01-01T00:00:00.000Z' },
        // @ts-expect-error simulate corrupt input
        { commentId: 'b', authorWallet: 'w', body: 'b', createdAt: 42 },
      ]),
    ).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('backfill-clubhouse-comments — estimateRowSize', () => {
  it('returns byte length of the JSON serialization', () => {
    const tiny = { a: 1 };
    expect(estimateRowSize(tiny)).toBe(Buffer.byteLength(JSON.stringify(tiny), 'utf8'));
  });

  it('flags posts above STUCK_POST_SIZE_THRESHOLD_BYTES as stuck', () => {
    // Build a synthetic post payload near the cap. Stuff a long body
    // field with random ASCII so the JSON serialization breaches the
    // threshold without needing real comments.
    const stuck = {
      drepId: 'drep1',
      postId: 'p1',
      body: 'x'.repeat(STUCK_POST_SIZE_THRESHOLD_BYTES + 10_000),
    };
    expect(estimateRowSize(stuck)).toBeGreaterThan(STUCK_POST_SIZE_THRESHOLD_BYTES);

    const small = { drepId: 'drep1', postId: 'p1', body: 'hi' };
    expect(estimateRowSize(small)).toBeLessThan(STUCK_POST_SIZE_THRESHOLD_BYTES);
  });
});

describe('backfill-clubhouse-comments — per-comment Put idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first run writes the row when the commentId is new', async () => {
    const { client, send } = makeDocClient([{}]);
    const outcome = await backfillOneComment(
      client,
      'drep1',
      'p1',
      {
        commentId: 'c1',
        authorWallet: 'w',
        body: 'hi',
        createdAt: '2026-05-27T10:00:00.000Z',
      },
      0,
    );
    expect(outcome).toBe('written');
    const cmd = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input).toMatchObject({
      TableName: 'clubhouse_comments',
      ConditionExpression: 'attribute_not_exists(commentId)',
    });
    const item = (cmd.input as { Item: Record<string, unknown> }).Item;
    expect(item['postKey']).toBe('drep1#p1');
    expect(item['commentId']).toBe('c1');
    expect(item['depth']).toBe(0);
  });

  it('second run skips when the commentId is already present', async () => {
    const { client, send } = makeDocClient([new ConditionalCheckFailedException()]);
    const outcome = await backfillOneComment(
      client,
      'drep1',
      'p1',
      { commentId: 'c1', authorWallet: 'w', body: 'hi', createdAt: '2026-05-27T10:00:00.000Z' },
      0,
    );
    expect(outcome).toBe('skipped');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('persists depth on the row when computed by computeDepths', async () => {
    const { client, send } = makeDocClient([{}, {}]);
    // Reply at depth 1.
    await backfillOneComment(
      client,
      'drep1',
      'p1',
      {
        commentId: 'reply',
        authorWallet: 'w',
        body: 'r',
        createdAt: '2026-05-27T11:00:00.000Z',
        parentCommentId: 'top',
      },
      1,
    );
    // Sub-reply at depth 2.
    await backfillOneComment(
      client,
      'drep1',
      'p1',
      {
        commentId: 'subreply',
        authorWallet: 'w',
        body: 'sr',
        createdAt: '2026-05-27T12:00:00.000Z',
        parentCommentId: 'reply',
      },
      2,
    );
    const items = send.mock.calls.map(
      (c) => (c[0] as { input: { Item: Record<string, unknown> } }).input.Item,
    );
    expect(items[0]!['depth']).toBe(1);
    expect(items[0]!['parentCommentId']).toBe('top');
    expect(items[1]!['depth']).toBe(2);
    expect(items[1]!['parentCommentId']).toBe('reply');
  });

  it('end-to-end: re-running the backfill on the same post produces stable skip outcomes', async () => {
    const comments = [
      { commentId: 'c1', authorWallet: 'w1', body: 'b1', createdAt: '2026-05-27T10:00:00.000Z' },
      { commentId: 'c2', authorWallet: 'w2', body: 'b2', createdAt: '2026-05-27T11:00:00.000Z' },
      {
        commentId: 'c3',
        authorWallet: 'w3',
        body: 'b3',
        createdAt: '2026-05-27T12:00:00.000Z',
        parentCommentId: 'c1',
      },
    ];
    const firstResponses = comments.map(() => ({}));
    const secondResponses = comments.map(() => new ConditionalCheckFailedException());
    const { client: first } = makeDocClient(firstResponses);
    const { client: second } = makeDocClient(secondResponses);
    const depths = computeDepths(comments);

    const firstOutcomes: string[] = [];
    for (const c of comments) {
      firstOutcomes.push(await backfillOneComment(first, 'drep1', 'p1', c, depths.get(c.commentId)!));
    }
    const secondOutcomes: string[] = [];
    for (const c of comments) {
      secondOutcomes.push(await backfillOneComment(second, 'drep1', 'p1', c, depths.get(c.commentId)!));
    }

    expect(firstOutcomes).toEqual(['written', 'written', 'written']);
    expect(secondOutcomes).toEqual(['skipped', 'skipped', 'skipped']);
  });
});

// Keep the SDK import alive so vitest doesn't tree-shake the mock setup.
void DynamoDBDocumentClient;
