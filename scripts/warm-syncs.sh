#!/usr/bin/env bash
#
# warm-syncs.sh — invoke the scheduled sync Lambdas once, immediately.
#
# Why this exists: EventBridge `rate()` rules don't fire until the first
# interval elapses, so a freshly deployed stack has empty sync tables for up to
# 30 min (directory) / 24 h (pool-metadata, power-history). Run this right after
# `cdk deploy` so a new environment is never empty (no DReps, no pool names…).
#
# Idempotent — every sync compares-then-writes, so re-running is safe.
#
# Usage:  scripts/warm-syncs.sh <stage>            # e.g. test | prod | dev
#         AWS_PROFILE=drep-platform scripts/warm-syncs.sh test
#
set -euo pipefail

STAGE="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="drep-platform-${STAGE}"

# directory + governance first (synchronous so the directory is populated before
# anyone connects); the rest async (they only enrich display).
SYNC_FUNCS_SYNC=(
  "${PREFIX}-drep-directory-sync"
  "${PREFIX}-governance-intake-sync"
)
SYNC_FUNCS_ASYNC=(
  "${PREFIX}-pool-metadata-sync"
  "${PREFIX}-cc-members-sync"
  "${PREFIX}-drep-power-history-sync"
)

echo "Warming syncs for stage=${STAGE} (region=${REGION})…"

for fn in "${SYNC_FUNCS_SYNC[@]}"; do
  echo -n "  ${fn} (sync) … "
  code=$(aws lambda invoke --region "$REGION" --function-name "$fn" \
    --invocation-type RequestResponse --cli-read-timeout 0 /dev/null \
    --query 'StatusCode' --output text 2>&1) || { echo "FAILED: $code"; continue; }
  echo "$code"
done

for fn in "${SYNC_FUNCS_ASYNC[@]}"; do
  echo -n "  ${fn} (async) … "
  code=$(aws lambda invoke --region "$REGION" --function-name "$fn" \
    --invocation-type Event /dev/null --query 'StatusCode' --output text 2>&1) || { echo "FAILED: $code"; continue; }
  echo "$code"
done

echo "Done. (governance + directory run every 1/30 min on schedule from here.)"
