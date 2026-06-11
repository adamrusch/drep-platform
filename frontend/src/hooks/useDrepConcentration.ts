import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type {
  ConcentrationPoint,
  ConcentrationTop,
} from '@/lib/concentrationView';

/** Response shape from `GET /dreps/concentration`. Mirrors the backend's
 *  handler types (kept inline so the FE has no cross-workspace import). */
export interface ConcentrationResponse {
  concentration: {
    drepCount: number;
    totalLabel: string;
    totalPower: string;
    topK: ConcentrationTop[];
    byPercent: ConcentrationPoint[];
  };
  markers: Array<{ pct: number; actions: string[] }>;
  defaultThresholdPct: number;
  thresholdsAsOf: string | null;
}

/** Cache key — singleton; the response shape is the entire view. */
const QUERY_KEY = ['drep-directory', 'concentration'] as const;

/**
 * Loads the voting-power concentration donut data. Cached for 60s — the
 * backend already caches the response for 30s; we go slightly longer
 * here so a tab-switch doesn't trigger an immediate refetch.
 */
export function useDrepConcentration(): ReturnType<
  typeof useQuery<ConcentrationResponse, Error>
> {
  return useQuery<ConcentrationResponse, Error>({
    queryKey: QUERY_KEY,
    queryFn: () => get<ConcentrationResponse>('/dreps/concentration'),
    staleTime: 60_000,
  });
}
