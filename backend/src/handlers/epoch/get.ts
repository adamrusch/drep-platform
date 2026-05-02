import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getLatestEpoch } from '../../lib/blockfrost';
import { ok, internalError } from '../_response';

interface EpochResponse {
  epoch: number;
  startTime: string;
  endTime: string;
  /** Seconds until this epoch ends — the SPA renders this as a countdown. */
  endsInSeconds: number;
}

/**
 * GET /epoch
 *
 * Public — no auth required. Wraps Blockfrost `epochsLatest` and returns the
 * shape the SPA needs for the epoch sidebar card and dashboard tile.
 *
 * Hits Blockfrost on every call, but the response is small and the route is
 * cacheable client-side (the SPA caches it for ~60 s). If anonymous abuse
 * becomes a concern we can move this behind the JWT authorizer.
 */
export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const epoch = await getLatestEpoch();
    const endsInSeconds = Math.max(0, epoch.end_time - Math.floor(Date.now() / 1000));
    const response: EpochResponse = {
      epoch: epoch.epoch,
      startTime: new Date(epoch.start_time * 1000).toISOString(),
      endTime: new Date(epoch.end_time * 1000).toISOString(),
      endsInSeconds,
    };
    return ok(response);
  } catch (err) {
    console.error('epoch/get handler error:', err);
    return internalError('Failed to fetch latest epoch');
  }
};
