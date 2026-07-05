/**
 * Shared HTTP response helpers for API handlers.
 *
 * Why this file exists:
 *   - Every handler needs to emit JSON with the right CORS headers AND
 *     the right status code AND (for /auth/* responses) cookies. Doing
 *     that inline in 22 handlers is begging for inconsistency.
 *   - The error path (`{"error", "message", "statusCode"}`) is what the
 *     SPA matches on; standardize the shape here so a misbehaving
 *     handler can't break the frontend's error-handling contract.
 *   - CORS allow-origin must be specific (not `*`) because we use
 *     `credentials: include` for the JWT cookie. CORS_ORIGIN is set
 *     per-Lambda in the CDK stack.
 *
 * Conventions for callers:
 *   - Return `ok(data)` for 200 with a single value. The data is wrapped
 *     in `{data: ...}` on the wire.
 *   - Use `created()` for 201, `noContent()` for 204.
 *   - Error helpers (`badRequest`, `unauthorized`, ...) all emit the
 *     same `{error, message, statusCode}` envelope.
 *   - For unhandled exceptions, call `handleError(err)` — it pattern-
 *     matches on common error names (`AuthorizationError`,
 *     `ConditionalCheckFailedException`) and falls through to 500.
 *   - Pass extra response headers as the second argument to `ok()`,
 *     and Set-Cookie strings as a `string[]` (HTTP API v2 splits
 *     cookies into a separate `cookies` field on the response).
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';

// CORS_ORIGIN must be a specific origin (not "*") because we use credentialed
// requests. The browser CORS spec requires Allow-Credentials: true with an
// explicit origin. The CDK stack sets CORS_ORIGIN per Lambda; this default
// is only used in local dev / unit tests where the env var is unset.
const DEFAULT_CORS_ORIGIN = 'https://drep.tools';

export const corsHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env['CORS_ORIGIN'] ?? DEFAULT_CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Vary': 'Origin',
};

/**
 * `JSON.stringify` doesn't know how to serialise `bigint` — it throws
 * `TypeError: Do not know how to serialize a BigInt`. After the 2026-05-28
 * P0-2 fix, DDB Number fields whose values exceed `Number.MAX_SAFE_INTEGER`
 * arrive in handlers as `bigint` (e.g. `comments.supportLovelace`). We
 * convert to string at the response boundary — the same format Cardano
 * tooling already uses for lovelace amounts everywhere else on the wire,
 * so the frontend doesn't need to change. Lossless, since BigInt → string
 * preserves every digit.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

export function ok<T>(
  data: T,
  extraHeadersOrCookies?: Record<string, string> | string[],
  setCookies?: string[],
): APIGatewayProxyResultV2 {
  // Back-compat: callers that pass a `string[]` get cookie behaviour;
  // callers that pass a `Record<string,string>` get extra response headers.
  const isCookieArray = Array.isArray(extraHeadersOrCookies);
  const extraHeaders = !isCookieArray && extraHeadersOrCookies ? extraHeadersOrCookies : undefined;
  const cookies = isCookieArray ? extraHeadersOrCookies : setCookies;
  const response: APIGatewayProxyResultV2 = {
    statusCode: 200,
    headers: extraHeaders ? { ...corsHeaders, ...extraHeaders } : corsHeaders,
    body: safeStringify({ data }),
  };
  if (cookies?.length) {
    (response as Record<string, unknown>)['cookies'] = cookies;
  }
  return response;
}

export function created<T>(data: T): APIGatewayProxyResultV2 {
  return {
    statusCode: 201,
    headers: corsHeaders,
    body: safeStringify({ data }),
  };
}

export function noContent(): APIGatewayProxyResultV2 {
  return {
    statusCode: 204,
    headers: corsHeaders,
    body: '',
  };
}

export function badRequest(message: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 400,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'BadRequest', message, statusCode: 400 }),
  };
}

export function unauthorized(message = 'Unauthorized'): APIGatewayProxyResultV2 {
  return {
    statusCode: 401,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Unauthorized', message, statusCode: 401 }),
  };
}

export function forbidden(message = 'Forbidden'): APIGatewayProxyResultV2 {
  return {
    statusCode: 403,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Forbidden', message, statusCode: 403 }),
  };
}

export function notFound(resource: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 404,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'NotFound', message: `${resource} not found`, statusCode: 404 }),
  };
}

export function conflict(message: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 409,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Conflict', message, statusCode: 409 }),
  };
}

export function internalError(message = 'Internal server error'): APIGatewayProxyResultV2 {
  return {
    statusCode: 500,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'InternalServerError', message, statusCode: 500 }),
  };
}

/**
 * 503 Service Unavailable. Use when a write surface depends on an
 * upstream we couldn't reach (Koios + Blockfrost both down) AND
 * uncertainty about the answer must not grant access — i.e. fail-CLOSED
 * paths. The frontend can present a "please retry" affordance keyed on
 * this status; differs semantically from a 500 (we know what happened —
 * upstream is unreachable — so this is an expected, transient condition).
 */
export function serviceUnavailable(message = 'Service Unavailable'): APIGatewayProxyResultV2 {
  return {
    statusCode: 503,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'ServiceUnavailable', message, statusCode: 503 }),
  };
}

/**
 * Parse a `?limit=<n>` query-string parameter into a bounded positive
 * integer.
 *
 * # The bug this consolidation replaces
 *
 * Four list handlers previously wrote the same one-liner:
 * ```ts
 * const limit = limitParam ? Math.min(parseInt(limitParam, 10), MAX) : DEFAULT;
 * ```
 * When `limitParam` is a non-empty non-numeric string (`?limit=foo`),
 * `parseInt` returns `NaN`, `Math.min(NaN, MAX)` returns `NaN`, and the
 * value is passed straight through to `queryItems` as `Limit`. The AWS
 * SDK's DynamoDB marshaller serialises `NaN` as `null`, which DynamoDB
 * treats as "no limit set" — so a garbage `limit=` param silently
 * flipped the response from a bounded page to the DDB default (up to
 * 1 MB of items). Real bug: `GET /comments/{id}?limit=xyz` returned a
 * larger response than `?limit=100` did.
 *
 * `parseLimit` fixes this by rejecting non-finite / non-positive parses
 * back to `defaultLimit`, matching the safe pattern that `directory/
 * list.ts` and `clubhouse/_rail.ts` already used inline. It also caps
 * at `maxLimit` so a caller passing `?limit=999999` gets `maxLimit`,
 * not `999999`.
 */
export function parseLimit(
  raw: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (raw == null || raw.length === 0) return defaultLimit;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultLimit;
  return Math.min(n, maxLimit);
}

export function handleError(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof Error) {
    if (err.name === 'AuthorizationError') {
      const e = err as Error & { statusCode: number };
      return e.statusCode === 403 ? forbidden(err.message) : unauthorized(err.message);
    }
    if (err.name === 'ConditionalCheckFailedException') {
      return conflict('Item already exists or condition check failed');
    }
  }
  console.error('Unhandled error:', err);
  return internalError();
}
