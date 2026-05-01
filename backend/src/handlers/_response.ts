import type { APIGatewayProxyResultV2 } from 'aws-lambda';

// CORS_ORIGIN must be a specific origin (not "*") because we use credentialed
// requests. The browser CORS spec requires Allow-Credentials: true with an
// explicit origin. The CDK stack sets CORS_ORIGIN per Lambda; this default
// matches the deployed CloudFront frontend.
const DEFAULT_CORS_ORIGIN = 'https://d31k3mmkrkmdvl.cloudfront.net';

export const corsHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env['CORS_ORIGIN'] ?? DEFAULT_CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Vary': 'Origin',
};

export function ok<T>(data: T, setCookies?: string[]): APIGatewayProxyResultV2 {
  const response: APIGatewayProxyResultV2 = {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ data }),
  };
  if (setCookies?.length) {
    (response as Record<string, unknown>)['cookies'] = setCookies;
  }
  return response;
}

export function created<T>(data: T): APIGatewayProxyResultV2 {
  return {
    statusCode: 201,
    headers: corsHeaders,
    body: JSON.stringify({ data }),
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
