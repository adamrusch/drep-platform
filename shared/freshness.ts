// ============================================================
// Cron cadences for scheduled jobs — CANONICAL SOURCE.
//
// Every value below is the single source of truth for one platform sync.
// The schema is consumed by:
//
//   - infra/lib/scheduler-stack.ts  → builds the EventBridge `events.Schedule`
//     objects directly from the structured `schedule` field, so the CDK
//     synthesises whatever this file says.
//   - frontend/src/pages/HelpDataFreshness.tsx → renders the table on the
//     public /help/data-freshness page so the documented cadences can never
//     drift from the actual behaviour.
//
// # Duplication policy (same shape as committeeMessages.ts)
//
// This file is DUPLICATED verbatim into:
//   - infra/lib/freshness.ts          (consumed by SchedulerStack)
//   - frontend/src/lib/freshness.ts   (consumed by the help page)
// The repo avoids cross-workspace imports — see backend/src/lib/types.ts.
// A golden test on each side asserts byte-identity with this file; keep all
// three copies identical and bump FRESHNESS_SCHEMA_VERSION on any change.
// ============================================================

export const FRESHNESS_SCHEMA_VERSION = 'v1';

/** Structured cadence consumable by AWS EventBridge. `rate` covers the
 *  `events.Schedule.rate(cdk.Duration.X)` family; `cron` covers
 *  `events.Schedule.cron({ minute, hour })`. The infra stack maps each
 *  variant to the right CDK helper one-to-one — no other shapes today. */
export type FreshnessSchedule =
  | { kind: 'rate'; minutes: number }
  | { kind: 'rate'; hours: number }
  | { kind: 'cron'; minute: string; hour: string };

/** One scheduled job. `id` is the stable identifier the scheduler uses to
 *  name its EventBridge rule (kebab-case). `label` + `description` are
 *  rendered to the public help page; `cadence` is the human-readable string
 *  the page shows next to each row. The `schedule` field is the truth the
 *  CDK consumes — `cadence` is a doc string, NOT a parse target. */
export interface FreshnessRow {
  id: string;
  label: string;
  cadence: string;
  description: string;
  schedule: FreshnessSchedule;
}

export const FRESHNESS: readonly FreshnessRow[] = [
  {
    id: 'governance-intake',
    label: 'Governance actions and vote tallies',
    cadence: 'Every 1 minute',
    description:
      'Koios is the primary metadata source; Blockfrost fills per-action vote tallies. Active actions only.',
    schedule: { kind: 'rate', minutes: 1 },
  },
  {
    id: 'drep-directory',
    label: 'DRep directory (registrations, metadata, last-active)',
    cadence: 'Every 30 minutes',
    description:
      'Koios drep_list + drep_info + drep_metadata. Per-DRep "last voted" times come from the 1-min governance sync.',
    schedule: { kind: 'rate', minutes: 30 },
  },
  {
    id: 'vote-rationale',
    label: 'Voter rationale bodies (CIP-100 anchors)',
    cadence: 'Every 30 minutes',
    description:
      'Caches the off-chain rationale JSON each voter references via their vote anchor. Active actions only; bounded to ~200 fetches per run.',
    schedule: { kind: 'rate', minutes: 30 },
  },
  {
    id: 'drep-power-history',
    label: 'DRep voting-power history (epoch series)',
    cadence: 'Daily at 02:00 UTC',
    description:
      'Voting power only moves at epoch boundaries (~every 5 days), so 24h granularity is plenty. Populates the per-DRep sparkline series.',
    schedule: { kind: 'cron', minute: '0', hour: '2' },
  },
  {
    id: 'pool-metadata',
    label: 'Stake pool metadata (ticker, name)',
    cadence: 'Daily at 03:00 UTC',
    description:
      'Koios pool_list + pool_metadata. Compare-then-write keeps quiet-day writes near zero; offset from the power-history pass to spread Koios RPS.',
    schedule: { kind: 'cron', minute: '0', hour: '3' },
  },
  {
    id: 'cc-members',
    label: 'Constitutional Committee members',
    cadence: 'Hourly (epoch-skip)',
    description:
      'Hourly EventBridge schedule, but the Lambda only calls Koios on actual epoch transitions (~5 calls per epoch).',
    schedule: { kind: 'rate', hours: 1 },
  },
  {
    id: 'revalidate-comment-stake',
    label: 'Comment-vote stake re-weighting (Sybil defense)',
    cadence: 'Every 3 hours',
    description:
      'Re-checks each voter wallet’s current stake via Koios and re-weights votes whose snapshot drifted. Also runs the clubhouse delegation-gate revoke pass.',
    schedule: { kind: 'rate', hours: 3 },
  },
  {
    id: 'committee-epoch-sweep',
    label: 'Committee proposal epoch-deadline sweep',
    cadence: 'Hourly',
    description:
      'Finalises open committee proposals whose underlying action’s voting window has closed (epoch deadline passed or GA terminal).',
    schedule: { kind: 'rate', hours: 1 },
  },
  {
    id: 'revalidate-onchain-roles',
    label: 'On-chain role re-validation (DRep/SPO/CC/proposer)',
    cadence: 'Daily at 02:30 UTC',
    description:
      'Re-resolves each active on-chain identity’s role via Koios and revokes any whose role no longer holds. Closes the gap where a deregistered role-holder keeps an unexpired JWT.',
    schedule: { kind: 'cron', minute: '30', hour: '2' },
  },
] as const;

/** Look up a freshness row by id. Throws if the id is unknown — the caller
 *  is asserting that the row exists, so a missing entry is a programmer
 *  error rather than a runtime condition to handle gracefully. */
export function getFreshnessRow(id: string): FreshnessRow {
  const row = FRESHNESS.find((r) => r.id === id);
  if (!row) {
    throw new Error(`Unknown freshness row id: ${id}`);
  }
  return row;
}
