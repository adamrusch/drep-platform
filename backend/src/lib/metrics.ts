/**
 * CloudWatch Embedded Metric Format (EMF) emitters.
 *
 * # Why EMF (and not PutMetricData)
 *
 * Two reasons:
 *   1. **No IAM** — the Lambda function already has `logs:PutLogEvents` via
 *      the `AWSLambdaBasicExecutionRole` managed policy. EMF is a JSON
 *      envelope written to stdout that CloudWatch Logs auto-extracts as
 *      a metric on the receiving side. `PutMetricData` requires a
 *      separate `cloudwatch:PutMetricData` grant on the role.
 *   2. **Cheaper** — `PutMetricData` is billed per API call; EMF rides
 *      on the existing log stream that already costs ~nothing.
 *
 * # When to use PutMetricData instead
 *
 * If a metric needs to be emitted from somewhere OTHER than a Lambda
 * runtime — e.g. a cron-driven CDK pipeline, a long-running task that
 * needs the metric visible inside a single second rather than the
 * ~minute log-ingestion lag — then `PutMetricData` is the right tool.
 * EMF metrics show up ~1 min after the log line is emitted; that's
 * fine for the slow security-defense counters this module surfaces.
 *
 * # Format reference
 *
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 *
 * The minimal envelope is:
 *
 * ```json
 * {
 *   "_aws": {
 *     "Timestamp": 1717619200000,
 *     "CloudWatchMetrics": [{
 *       "Namespace": "DrepPlatform/Identity",
 *       "Dimensions": [["Stage"]],
 *       "Metrics": [{ "Name": "IdentityCoseMissingAddressHeader", "Unit": "Count" }]
 *     }]
 *   },
 *   "Stage": "prod",
 *   "IdentityCoseMissingAddressHeader": 1
 * }
 * ```
 *
 * CloudWatch Logs ingests the line, sees `_aws.CloudWatchMetrics`, and
 * auto-creates a metric on `DrepPlatform/Identity` with the requested
 * dimensions. We write directly via `console.log` (which Lambda
 * forwards to CloudWatch Logs verbatim) — no SDK dependency.
 */

/** Namespace under which identity-subsystem metrics are emitted. One
 *  namespace per concerned slice keeps the CloudWatch console navigable. */
export const IDENTITY_METRIC_NAMESPACE = 'DrepPlatform/Identity';

/**
 * Emit a single-Count metric to the identity namespace under EMF.
 *
 * Always rides the current `STAGE` env var as a dimension so dev/test/
 * prod can be filtered separately in the CloudWatch console without
 * cross-environment noise.
 *
 * # Failure mode
 *
 * Best-effort. If the stage isn't readable for any reason (it always
 * is in our Lambdas), fall back to dimension `unknown` so the metric
 * still emits. NEVER throws — a metric emit must never fail a request
 * path.
 */
export function emitIdentityMetric(
  metricName: string,
  value = 1,
  extraDimensions: Record<string, string> = {},
): void {
  try {
    const stage = process.env['STAGE'] ?? 'unknown';
    const dimensions: Record<string, string> = { Stage: stage, ...extraDimensions };
    const dimensionKeys = Object.keys(dimensions);
    const envelope = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: IDENTITY_METRIC_NAMESPACE,
            Dimensions: [dimensionKeys],
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
        ],
      },
      ...dimensions,
      [metricName]: value,
    };
    // CloudWatch Logs reads the raw line. JSON.stringify keeps the
    // envelope a single line per CloudWatch's EMF requirements.
    console.log(JSON.stringify(envelope));
  } catch {
    // Best-effort. Never throw out of a metric emit.
  }
}

// ---------------------------------------------------------------------------
// Specific metric names — kept as constants so a typo at the call site
// doesn't silently fragment a metric into two distinct CloudWatch series.
// ---------------------------------------------------------------------------

/** Sprint 3 — counts CIP-8 rejections whose root cause is the missing /
 *  invalid `address` protected-header field. Oracle flagged that some
 *  older wallets omit this; we stay strict (reject) but quantify the
 *  affected population before any future decision to relax. */
export const METRIC_IDENTITY_COSE_MISSING_ADDRESS_HEADER =
  'IdentityCoseMissingAddressHeader';

/** S4 hardening (2026-06-10 security review) — counts proposer logins
 *  that succeeded under the relaxed COSE-address path
 *  (`addressBound === false`). The Koios resolution downstream is the
 *  authoritative role check, but proposer is a privileged surface
 *  (governance writes); tracking the unbound-address rate per Stage so
 *  operations can monitor for anomalies (a sudden spike could indicate
 *  a wallet pushing payloads without the address header to bypass the
 *  reward-address pre-filter). The metric is informational only — the
 *  login proceeds normally. */
export const METRIC_IDENTITY_PROPOSER_ADDRESS_UNBOUND =
  'IdentityProposerAddressUnbound';
