/**
 * Tests for the Clubhouse `votePoll` handler.
 *
 * # SEC-2 2026-05-28 — atomic vote write
 *
 * The handler used to read-modify-write the post row (same RMW class as
 * the comment-array race fixed in P0-3). Concurrent votes from two
 * wallets each read the same `pollOptions[i].votes` baseline, each
 * incremented in memory, each `putItem`-d the whole row back — one
 * vote silently lost. The fix replaces the RMW with a single atomic
 * UpdateExpression:
 *
 *   SET pollVotes.<wallet> = :newIdx, updatedAt = :now
 *   ADD pollOptions[newIdx].votes :one[, pollOptions[prevIdx].votes :negOne]
 *
 * guarded by `attribute_exists(postId) AND pollVotes.<wallet> = :prev`
 * (or `attribute_not_exists(pollVotes.<wallet>)` for first-time votes).
 *
 * # Coverage
 *
 *   - Validation: missing path params 400, missing body 400, non-integer
 *     optionIndex 400, post not found 404, non-poll post 400, closed poll
 *     400, out-of-range index 400.
 *   - Idempotency: voting the same option twice short-circuits without
 *     a write.
 *   - First-time vote: UpdateExpression uses `attribute_not_exists` guard
 *     and only the SET + single ADD for the new option.
 *   - Change vote: UpdateExpression includes the negOne ADD on the old
 *     option, and the guard checks the prior value.
 *   - Concurrent vote from a DIFFERENT wallet doesn't block: independent
 *     pollVotes paths mean independent guards (modeled in the test by
 *     simulating two parallel calls + asserting both reach DDB without
 *     either failing its own condition).
 *   - Same wallet sending a concurrent vote: first attempt fails CCFE,
 *     handler re-reads, retries with the actual prev, succeeds.
 *   - Hard conflict (still CCFE after retry) surfaces as 409.
 *   - Post deleted between read + write: surfaces as 404.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  docClient: { send: vi.fn() },
  getItem: vi.fn(),
  tableNames: {
    users: 'test-users',
    drepCommittees: 'test-drep_committees',
    drepDirectory: 'test-drep_directory',
    governanceActions: 'test-governance_actions',
    governanceVotes: 'test-governance_votes',
    comments: 'test-comments',
    commentVotes: 'test-comment_votes',
    clubhousePosts: 'test-clubhouse_posts',
    clubhouseComments: 'test-clubhouse_comments',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

import { docClient, getItem } from '../../lib/dynamodb';
import { handler } from './votePoll';

const mockSend = vi.mocked(docClient.send);
const mockGet = vi.mocked(getItem);

const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
const POST_ID = 'post-abc';
const WALLET_A = 'stake1uy_walletA';
const WALLET_B = 'stake1uy_walletB';

function buildEvent(opts: {
  drepId: string;
  postId: string;
  walletAddress: string;
  body: unknown;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: JSON.stringify(opts.body),
    pathParameters: { drepId: opts.drepId, postId: opts.postId },
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(['delegator']),
          sessionType: 'normal',
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer['requestContext'],
    rawPath: '',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    routeKey: '',
    version: '2.0',
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function buildPollPost(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    drepId: DREP_ID,
    postId: POST_ID,
    authorWallet: 'stake1u_author',
    isDRepPost: false,
    body: 'Q?',
    comments: [],
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    type: 'poll',
    title: 'Pick one',
    pollOptions: [
      { id: 'a', label: 'Yes', votes: 0 },
      { id: 'b', label: 'No', votes: 0 },
      { id: 'c', label: 'Abstain', votes: 0 },
    ],
    pollMultiple: false,
    pollClosesAt: '2099-12-31T23:59:59.000Z',
    pollVotes: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: every UpdateCommand succeeds and returns an Attributes
  // payload modelled after the input post.
  mockSend.mockResolvedValue({ Attributes: buildPollPost() } as never);
});

/** Helper — pull the LAST UpdateCommand input that was issued. */
function lastUpdateInput(): {
  TableName: string;
  Key: Record<string, unknown>;
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  const calls = mockSend.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1]![0] as unknown as {
    input: {
      TableName: string;
      Key: Record<string, unknown>;
      UpdateExpression: string;
      ConditionExpression?: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  };
  return last.input;
}

describe('clubhouse/votePoll — validation', () => {
  it('rejects missing path params with 400', async () => {
    mockGet.mockResolvedValue(buildPollPost() as never);
    const event = buildEvent({
      drepId: '',
      postId: '',
      walletAddress: WALLET_A,
      body: { optionIndex: 0 },
    });
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects missing body with 400', async () => {
    const event = buildEvent({
      drepId: DREP_ID,
      postId: POST_ID,
      walletAddress: WALLET_A,
      body: {},
    });
    // Override body to undefined to simulate a missing event.body
    (event as { body?: string }).body = undefined;
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects non-integer optionIndex with 400', async () => {
    mockGet.mockResolvedValue(buildPollPost() as never);
    const event = buildEvent({
      drepId: DREP_ID,
      postId: POST_ID,
      walletAddress: WALLET_A,
      body: { optionIndex: 1.5 },
    });
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the post does not exist', async () => {
    mockGet.mockResolvedValue(undefined);
    const event = buildEvent({
      drepId: DREP_ID,
      postId: POST_ID,
      walletAddress: WALLET_A,
      body: { optionIndex: 0 },
    });
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the post is not a poll', async () => {
    mockGet.mockResolvedValue(buildPollPost({ type: 'discussion', pollOptions: undefined }) as never);
    const event = buildEvent({
      drepId: DREP_ID,
      postId: POST_ID,
      walletAddress: WALLET_A,
      body: { optionIndex: 0 },
    });
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the poll has closed', async () => {
    mockGet.mockResolvedValue(buildPollPost({ pollClosesAt: '2020-01-01T00:00:00.000Z' }) as never);
    const event = buildEvent({
      drepId: DREP_ID,
      postId: POST_ID,
      walletAddress: WALLET_A,
      body: { optionIndex: 0 },
    });
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects with 400 when optionIndex is out of range', async () => {
    mockGet.mockResolvedValue(buildPollPost() as never);
    const event = buildEvent({
      drepId: DREP_ID,
      postId: POST_ID,
      walletAddress: WALLET_A,
      body: { optionIndex: 99 },
    });
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('short-circuits idempotent same-option votes (no UpdateItem issued)', async () => {
    mockGet.mockResolvedValue(
      buildPollPost({ pollVotes: { [WALLET_A]: 1 } }) as never,
    );
    const event = buildEvent({
      drepId: DREP_ID,
      postId: POST_ID,
      walletAddress: WALLET_A,
      body: { optionIndex: 1 },
    });
    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('clubhouse/votePoll — atomic write semantics', () => {
  it('first-time vote: SET + single ADD :one, guard uses attribute_not_exists', async () => {
    mockGet.mockResolvedValue(buildPollPost({ pollVotes: {} }) as never);
    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 2 },
      }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = lastUpdateInput();

    expect(input.TableName).toBe('test-clubhouse_posts');
    expect(input.Key).toEqual({ drepId: DREP_ID, postId: POST_ID });
    expect(input.UpdateExpression).toMatch(/SET .* ADD .*/);
    // The vote SET targets `pollVotes.<wallet>` via aliases.
    expect(input.UpdateExpression).toMatch(/#pv\.#wallet = :newIdx/);
    // The ADD :one targets the newly-chosen option's bucket. List
    // indices are literals in the expression string per DDB rules.
    expect(input.UpdateExpression).toMatch(/#po\[2\]\.#v :one/);
    // First-time vote MUST NOT include a :negOne (no previous bucket to
    // decrement).
    expect(input.UpdateExpression).not.toMatch(/:negOne/);

    // Guard: attribute_exists on post + attribute_not_exists on wallet entry.
    expect(input.ConditionExpression).toMatch(/attribute_exists/);
    expect(input.ConditionExpression).toMatch(/attribute_not_exists/);

    // Attribute names + values.
    expect(input.ExpressionAttributeNames['#wallet']).toBe(WALLET_A);
    expect(input.ExpressionAttributeNames['#pv']).toBe('pollVotes');
    expect(input.ExpressionAttributeNames['#po']).toBe('pollOptions');
    expect(input.ExpressionAttributeValues[':newIdx']).toBe(2);
    expect(input.ExpressionAttributeValues[':one']).toBe(1);
  });

  it('change vote: ADD :one on new option AND ADD :negOne on previous option', async () => {
    // Wallet previously voted option 0 → switches to option 2. Atomic
    // update must add 1 to bucket[2] AND subtract 1 from bucket[0] in a
    // single UpdateItem.
    mockGet.mockResolvedValue(
      buildPollPost({ pollVotes: { [WALLET_A]: 0 } }) as never,
    );
    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 2 },
      }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockSend).toHaveBeenCalledTimes(1);

    const input = lastUpdateInput();
    expect(input.UpdateExpression).toMatch(/ADD .*#po\[2\]\.#v :one.*#po\[0\]\.#v :negOne/s);
    expect(input.ExpressionAttributeValues[':one']).toBe(1);
    expect(input.ExpressionAttributeValues[':negOne']).toBe(-1);

    // Guard: wallet's prior vote MUST still equal :prev (=0) for the
    // write to land. Prevents a concurrent same-wallet vote from
    // double-counting.
    expect(input.ConditionExpression).toMatch(/#pv\.#wallet = :prev/);
    expect(input.ExpressionAttributeValues[':prev']).toBe(0);
  });

  it('updatedAt is bumped in the SET clause', async () => {
    mockGet.mockResolvedValue(buildPollPost() as never);
    await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 1 },
      }),
    );
    const input = lastUpdateInput();
    expect(input.UpdateExpression).toMatch(/#u = :now/);
    expect(input.ExpressionAttributeNames['#u']).toBe('updatedAt');
    expect(typeof input.ExpressionAttributeValues[':now']).toBe('string');
    expect(input.ExpressionAttributeValues[':now']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('clubhouse/votePoll — concurrency (the bug we fixed)', () => {
  it('two wallets voting for different options both land — independent updates, no race', async () => {
    // Model: wallet A votes option 0, wallet B votes option 1, both
    // observe an EMPTY pollVotes map (race window). Each Update
    // targets a DIFFERENT pollVotes path (pollVotes.<A> vs pollVotes.<B>)
    // and DIFFERENT counter buckets (pollOptions[0] vs pollOptions[1]).
    // Both guards (attribute_not_exists on the wallet's path) succeed
    // even though the row's pollVotes map "changed" between A's read and
    // B's read — because the paths don't overlap.
    mockGet.mockResolvedValue(buildPollPost({ pollVotes: {} }) as never);

    const [resA, resB] = await Promise.all([
      handler(
        buildEvent({
          drepId: DREP_ID,
          postId: POST_ID,
          walletAddress: WALLET_A,
          body: { optionIndex: 0 },
        }),
      ),
      handler(
        buildEvent({
          drepId: DREP_ID,
          postId: POST_ID,
          walletAddress: WALLET_B,
          body: { optionIndex: 1 },
        }),
      ),
    ]);

    expect((resA as APIGatewayProxyResultV2 & { statusCode: number }).statusCode).toBe(200);
    expect((resB as APIGatewayProxyResultV2 & { statusCode: number }).statusCode).toBe(200);

    // Both writes reached DDB — neither was silently swallowed.
    expect(mockSend).toHaveBeenCalledTimes(2);
    const inputs = mockSend.mock.calls.map(
      (c) => (c[0] as unknown as { input: { ExpressionAttributeNames: Record<string, string> } }).input,
    );
    const wallets = inputs.map((i) => i.ExpressionAttributeNames['#wallet']).sort();
    expect(wallets).toEqual([WALLET_A, WALLET_B].sort());
  });

  it('wallet re-votes (moves bucket) atomically — UpdateExpression decrements old AND increments new', async () => {
    // Concrete moving-vote scenario: wallet voted 'Yes' (idx 0). Now
    // changes to 'No' (idx 1). One UpdateItem should:
    //   - SET pollVotes.<wallet> = 1
    //   - ADD pollOptions[1].votes :one    → 'No' goes up by 1
    //   - ADD pollOptions[0].votes :negOne → 'Yes' goes down by 1
    // Net: total vote count unchanged, wallet's vote MOVED. Not
    // duplicated.
    mockGet.mockResolvedValue(
      buildPollPost({ pollVotes: { [WALLET_A]: 0 } }) as never,
    );
    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 1 },
      }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockSend).toHaveBeenCalledTimes(1);

    const input = lastUpdateInput();
    expect(input.UpdateExpression).toMatch(/ADD .*#po\[1\]\.#v :one.*#po\[0\]\.#v :negOne/s);
    expect(input.ExpressionAttributeValues[':one']).toBe(1);
    expect(input.ExpressionAttributeValues[':negOne']).toBe(-1);
  });

  it('same-wallet race: first attempt fails CCFE, handler re-reads and retries successfully', async () => {
    // Scenario: wallet's prior vote moved between our Get and our
    // Update (rare; the same wallet sent two near-simultaneous votes).
    // First UpdateItem fails CCFE because :prev (=undefined→
    // attribute_not_exists) no longer matches. Handler re-reads, finds
    // the new prev, retries, succeeds.
    mockGet
      .mockResolvedValueOnce(buildPollPost({ pollVotes: {} }) as never)
      // Re-read sees a concurrent vote already landed on option 0.
      .mockResolvedValueOnce(
        buildPollPost({ pollVotes: { [WALLET_A]: 0 } }) as never,
      );

    let sendCalls = 0;
    mockSend.mockImplementation(async () => {
      sendCalls++;
      if (sendCalls === 1) {
        throw Object.assign(new Error('CCFE'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return { Attributes: buildPollPost({ pollVotes: { [WALLET_A]: 2 } }) } as never;
    });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 2 },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    // Two Update attempts, one re-read.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenCalledTimes(2);

    // The second attempt should carry :prev = 0 (the discovered prior).
    const secondInput = lastUpdateInput();
    expect(secondInput.ExpressionAttributeValues[':prev']).toBe(0);
    expect(secondInput.UpdateExpression).toMatch(/#po\[0\]\.#v :negOne/);
  });

  it('same-wallet race where re-read shows wallet already on the desired option: short-circuits 200', async () => {
    // Scenario: between our Get + Update, a concurrent same-wallet vote
    // landed on the SAME option the caller is asking for. After CCFE
    // we re-read, see we're already there, and return 200 without
    // another Update — the concurrent vote effectively WAS this vote.
    mockGet
      .mockResolvedValueOnce(buildPollPost({ pollVotes: {} }) as never)
      .mockResolvedValueOnce(
        buildPollPost({ pollVotes: { [WALLET_A]: 2 } }) as never,
      );

    let sendCalls = 0;
    mockSend.mockImplementation(async () => {
      sendCalls++;
      if (sendCalls === 1) {
        throw Object.assign(new Error('CCFE'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return { Attributes: buildPollPost() } as never;
    });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 2 },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    // Only the first failed Update attempt; no retry Update fired
    // because the re-read already showed convergence.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('hard conflict after retry surfaces as 409', async () => {
    // Pathological case: two retries in a row both fail CCFE. The
    // caller is asked to refresh and try again. Without the 409
    // surface we'd silently 500.
    mockGet
      .mockResolvedValue(buildPollPost({ pollVotes: {} }) as never);

    mockSend.mockRejectedValue(
      Object.assign(new Error('CCFE'), {
        name: 'ConditionalCheckFailedException',
      }),
    );

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 1 },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 409 });
    // Two attempts: initial + one retry.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('post deleted between read and write surfaces as 404', async () => {
    // The UpdateItem fails CCFE because of the
    // `attribute_exists(postId)` guard. Re-read returns undefined →
    // 404 instead of 409.
    mockGet
      .mockResolvedValueOnce(buildPollPost({ pollVotes: {} }) as never)
      .mockResolvedValueOnce(undefined);

    mockSend.mockRejectedValue(
      Object.assign(new Error('CCFE'), {
        name: 'ConditionalCheckFailedException',
      }),
    );

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET_A,
        body: { optionIndex: 0 },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 404 });
  });
});
